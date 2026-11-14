import { Peer } from 'peerjs'
import { peerLink, type PadLink } from './link'
import { BUTTON_COUNT, PAD_PARAM, VIRTUAL_PAD_ID, peerOptions, type ConsoleMessage, type PhoneMessage } from './protocol'

const ID_STORAGE_KEY = 'snes-remote-console-id'
const ID_PREFIX = 'snes-console-'
/** Phones resend their state every second; silence means trouble. */
const STALE_RELEASE_MS = 2500
const STALE_DROP_MS = 8000

export type HostStatus = 'starting' | 'ready' | 'offline'

interface VirtualPad {
  link: PadLink
  drop: () => void
  mask: number
  timestamp: number
}

/**
 * Console side of the phone controller. Registers with the PeerJS broker under
 * a stable id (so a phone can reconnect after either side reloads), accepts
 * data connections, and surfaces each connected phone as a Gamepad through a
 * patched navigator.getGamepads().
 */
export class RemoteHost {
  status: HostStatus = 'starting'
  onChange: (() => void) | null = null
  onPhoneConnected: ((player: number) => void) | null = null
  onPhoneDisconnected: ((player: number) => void) | null = null

  private peer: Peer | null = null
  private id: string
  private readonly pads: VirtualPad[] = []
  private nativeGetGamepads: (() => (Gamepad | null)[]) | null = null

  constructor() {
    this.id = loadId() ?? newId()
  }

  get phoneCount(): number {
    return this.pads.length
  }

  get controllerUrl(): string {
    const url = new URL(window.location.href)
    url.hash = ''
    url.search = ''
    url.searchParams.set(PAD_PARAM, this.id)
    return url.toString()
  }

  start(): void {
    this.patchGamepads()
    this.connectBroker()
    window.setInterval(() => this.reapStale(), 1000)
    // Coming out of a tunnel: don't wait for the next retry tick.
    window.addEventListener('online', () => this.scheduleBrokerRetry(0))
  }

  /**
   * A phone that locks its screen or loses Wi-Fi may never send a close. Let go
   * of its buttons quickly, and free its slot a little later.
   */
  private reapStale(): void {
    const now = performance.now()
    for (const pad of [...this.pads]) {
      const silent = now - pad.timestamp
      if (silent > STALE_DROP_MS) {
        pad.link.close()
        pad.drop()
      } else if (silent > STALE_RELEASE_MS) pad.mask = 0
    }
  }

  private retries = 0
  private brokerTimer = 0
  private everOpened = false

  /**
   * The broker is only needed to introduce new phones. Phones that are already
   * paired talk to us directly, so a broker outage (a tunnel, a 5G dead spot)
   * must never tear down the Peer: destroying it would close every data
   * channel. Once we've been online we only ever call reconnect().
   */
  private connectBroker(): void {
    this.peer?.destroy()
    this.everOpened = false
    const peer = new Peer(this.id, peerOptions())
    this.peer = peer

    peer.on('open', (id) => {
      this.id = id
      this.everOpened = true
      this.retries = 0
      saveId(id)
      this.setStatus('ready')
    })
    peer.on('connection', (conn) => this.accept(peerLink(conn)))
    peer.on('disconnected', () => {
      this.setStatus('offline')
      this.scheduleBrokerRetry(2000)
    })
    peer.on('error', (err) => {
      const type = (err as { type?: string }).type
      if (type === 'unavailable-id' && !this.everOpened) {
        // Usually our own previous session still holding the id for a few
        // seconds after a reload; retry, then give up and take a new one.
        this.retries++
        if (this.retries > 3) {
          this.id = newId()
          this.retries = 0
        }
        window.setTimeout(() => this.connectBroker(), 2500)
      } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed' || type === 'unavailable-id') {
        this.setStatus('offline')
        this.scheduleBrokerRetry(4000)
      }
    })
  }

  private scheduleBrokerRetry(delay: number): void {
    window.clearTimeout(this.brokerTimer)
    this.brokerTimer = window.setTimeout(() => this.retryBroker(), delay)
  }

  private retryBroker(): void {
    const peer = this.peer
    if (!peer || peer.destroyed) return this.connectBroker()
    if (!this.everOpened) {
      // Never got online, so no phones can be attached: a fresh start is safe.
      if (this.pads.length === 0) return this.connectBroker()
    } else if (peer.disconnected) {
      peer.reconnect()
    }
    // Keep trying until the broker answers; 'open' resets the status.
    if (this.status !== 'ready') this.scheduleBrokerRetry(5000)
  }

  /** The id phones use to find this console through the broker. */
  get consoleId(): string {
    return this.id
  }

  /** Attach a phone, however it was paired (broker or offline QR swap). */
  accept(link: PadLink): void {
    const pad: VirtualPad = { link, drop: () => undefined, mask: 0, timestamp: performance.now() }
    link.onOpen(() => {
      pad.timestamp = performance.now()
      this.pads.push(pad)
      const player = this.playerOf(pad)
      const hello: ConsoleMessage = { t: 'hello', player }
      link.send(hello)
      this.onPhoneConnected?.(player)
      this.onChange?.()
    })
    link.onData((raw) => {
      const msg = raw as PhoneMessage
      if (msg && msg.t === 'in' && typeof msg.m === 'number') {
        pad.mask = msg.m
        pad.timestamp = performance.now()
      }
    })
    const drop = () => {
      const i = this.pads.indexOf(pad)
      if (i < 0) return
      const player = this.playerOf(pad)
      this.pads.splice(i, 1)
      this.onPhoneDisconnected?.(player)
      this.onChange?.()
    }
    pad.drop = drop
    link.onClose(drop)
  }

  private setStatus(status: HostStatus): void {
    if (this.status === status) return
    this.status = status
    this.onChange?.()
  }

  /** 1-based player number = the gamepad slot the engine will read it from. */
  private playerOf(pad: VirtualPad): number {
    const list = navigator.getGamepads()
    for (let i = 0; i < list.length; i++) {
      if ((list[i] as unknown as { __pad?: VirtualPad } | null)?.__pad === pad) return i + 1
    }
    return 1
  }

  private patchGamepads(): void {
    if (this.nativeGetGamepads) return
    const native = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : () => []
    this.nativeGetGamepads = native
    navigator.getGamepads = () => {
      const out: (Gamepad | null)[] = Array.from(native())
      for (const pad of this.pads) {
        const gp = toGamepad(pad)
        const free = out.findIndex((g) => !g || !g.connected)
        if (free >= 0) {
          ;(gp as { index: number }).index = free
          out[free] = gp
        } else {
          ;(gp as { index: number }).index = out.length
          out.push(gp)
        }
      }
      return out
    }
  }
}

function toGamepad(pad: VirtualPad): Gamepad {
  const buttons: GamepadButton[] = []
  for (let i = 0; i < BUTTON_COUNT; i++) {
    const pressed = (pad.mask & (1 << i)) !== 0
    buttons.push({ pressed, touched: pressed, value: pressed ? 1 : 0 })
  }
  return {
    id: VIRTUAL_PAD_ID,
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp: pad.timestamp,
    axes: [0, 0, 0, 0],
    buttons,
    hapticActuator: null,
    vibrationActuator: null,
    __pad: pad,
  } as unknown as Gamepad
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return ID_PREFIX + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10)
}

function loadId(): string | null {
  try {
    return localStorage.getItem(ID_STORAGE_KEY)
  } catch {
    return null
  }
}

function saveId(id: string): void {
  try {
    localStorage.setItem(ID_STORAGE_KEY, id)
  } catch {
    // best effort
  }
}
