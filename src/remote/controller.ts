import { Peer, type DataConnection } from 'peerjs'
import { BTN, peerOptions, type ConsoleMessage, type PhoneMessage } from './protocol'

const RETRY_MS = 1500
const KEEPALIVE_MS = 1000

/**
 * Phone side: a full-screen touch SNES pad that streams its button bitmask to
 * the console over a PeerJS data channel. Every touch is re-hit-tested on each
 * move, so thumbs can slide across the D-pad and between face buttons.
 */
export function runController(root: HTMLElement, consoleId: string): void {
  document.body.classList.add('controller-mode')
  root.innerHTML = `
    <div class="pad">
      <div class="pad-row pad-top">
        <div class="shoulder" data-btn="${BTN.L}">L</div>
        <div class="pad-status" id="pad-status">Connecting…</div>
        <div class="shoulder" data-btn="${BTN.R}">R</div>
      </div>
      <div class="pad-row pad-main">
        <div class="dpad" id="dpad">
          <div class="arm up" data-bit="${BTN.UP}"></div>
          <div class="arm down" data-bit="${BTN.DOWN}"></div>
          <div class="arm left" data-bit="${BTN.LEFT}"></div>
          <div class="arm right" data-bit="${BTN.RIGHT}"></div>
          <div class="hub"></div>
        </div>
        <div class="pad-center">
          <div class="pill" data-btn="${BTN.SELECT}">SELECT</div>
          <div class="pill" data-btn="${BTN.START}">START</div>
          <div class="pill menu" data-btn="${BTN.MENU}">MENU</div>
        </div>
        <div class="face" id="face">
          <div class="fbtn x" data-face="${BTN.X}">X</div>
          <div class="fbtn y" data-face="${BTN.Y}">Y</div>
          <div class="fbtn a" data-face="${BTN.A}">A</div>
          <div class="fbtn b" data-face="${BTN.B}">B</div>
        </div>
      </div>
    </div>`

  const statusEl = root.querySelector<HTMLElement>('#pad-status')!
  const dpad = root.querySelector<HTMLElement>('#dpad')!
  const face = root.querySelector<HTMLElement>('#face')!
  const faceBtns = Array.from(face.querySelectorAll<HTMLElement>('[data-face]'))
  const allLit = Array.from(root.querySelectorAll<HTMLElement>('[data-btn],[data-face],[data-bit]'))

  // ------------------------------------------------------------- touch input

  /** Touches that began on the D-pad stay on it even if the thumb drifts off. */
  const dpadTouches = new Set<number>()
  let mask = 0

  const dpadMask = (x: number, y: number): number => {
    const r = dpad.getBoundingClientRect()
    const dx = x - (r.left + r.width / 2)
    const dy = y - (r.top + r.height / 2)
    const len = Math.hypot(dx, dy)
    if (len < r.width * 0.12) return 0
    // Each direction covers ±67.5°, so diagonals get a 45° overlap sector.
    const k = Math.cos((67.5 * Math.PI) / 180)
    let m = 0
    if (dx > k * len) m |= 1 << BTN.RIGHT
    if (dx < -k * len) m |= 1 << BTN.LEFT
    if (dy > k * len) m |= 1 << BTN.DOWN
    if (dy < -k * len) m |= 1 << BTN.UP
    return m
  }

  /** Press every face button within ~1.45 radii: hitting the gap presses both. */
  const faceMask = (x: number, y: number): number => {
    let m = 0
    for (const el of faceBtns) {
      const r = el.getBoundingClientRect()
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2))
      if (d <= (r.width / 2) * 1.45) m |= 1 << Number(el.dataset.face)
    }
    return m
  }

  const touchMask = (t: Touch): number => {
    if (dpadTouches.has(t.identifier)) return dpadMask(t.clientX, t.clientY)
    const fr = face.getBoundingClientRect()
    if (t.clientX >= fr.left - 20 && t.clientX <= fr.right + 20 && t.clientY >= fr.top - 20 && t.clientY <= fr.bottom + 20) {
      return faceMask(t.clientX, t.clientY)
    }
    const el = document.elementFromPoint(t.clientX, t.clientY)?.closest<HTMLElement>('[data-btn]')
    return el ? 1 << Number(el.dataset.btn) : 0
  }

  const onTouch = (e: TouchEvent): void => {
    e.preventDefault()
    if (e.type === 'touchstart') {
      requestWakeLock()
      for (const t of Array.from(e.changedTouches)) {
        if (document.elementFromPoint(t.clientX, t.clientY)?.closest('#dpad')) dpadTouches.add(t.identifier)
      }
    } else if (e.type === 'touchend' || e.type === 'touchcancel') {
      for (const t of Array.from(e.changedTouches)) dpadTouches.delete(t.identifier)
    }
    let m = 0
    for (const t of Array.from(e.touches)) m |= touchMask(t)
    setMask(m)
  }

  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
    root.addEventListener(type, onTouch, { passive: false })
  }
  // iOS pinch/double-tap zoom and the long-press callout.
  document.addEventListener('gesturestart', (e) => e.preventDefault())
  document.addEventListener('contextmenu', (e) => e.preventDefault())

  const setMask = (m: number): void => {
    if (m === mask) return
    mask = m
    for (const el of allLit) {
      const bit = Number(el.dataset.btn ?? el.dataset.face ?? el.dataset.bit)
      el.classList.toggle('on', (m & (1 << bit)) !== 0)
    }
    send()
  }

  // ------------------------------------------------------------- connection

  let conn: DataConnection | null = null
  let retryTimer = 0

  const send = (): void => {
    if (!conn?.open) return
    const msg: PhoneMessage = { t: 'in', m: mask }
    void conn.send(msg)
  }

  const setStatus = (text: string, state: 'wait' | 'ok' | 'bad'): void => {
    statusEl.textContent = text
    statusEl.dataset.state = state
  }

  const peer = new Peer(peerOptions())

  const connect = (): void => {
    window.clearTimeout(retryTimer)
    if (peer.destroyed) return
    if (peer.disconnected) {
      peer.reconnect()
      return
    }
    conn?.close()
    const c = peer.connect(consoleId, { reliable: true, serialization: 'json' })
    conn = c
    c.on('open', () => {
      setStatus('Connected', 'ok')
      send()
    })
    c.on('data', (raw) => {
      const msg = raw as ConsoleMessage
      if (msg?.t === 'hello') setStatus(`Player ${msg.player}`, 'ok')
    })
    const lost = () => {
      if (conn !== c) return
      conn = null
      setStatus('Reconnecting…', 'bad')
      retryTimer = window.setTimeout(connect, RETRY_MS)
    }
    c.on('close', lost)
    c.on('error', lost)
  }

  peer.on('open', () => connect())
  peer.on('disconnected', () => {
    setStatus('Reconnecting…', 'bad')
    window.setTimeout(() => !peer.destroyed && peer.reconnect(), RETRY_MS)
  })
  peer.on('error', (err) => {
    const type = (err as { type?: string }).type
    if (type === 'peer-unavailable') {
      setStatus('Console not found — is the emulator open on the iPad?', 'bad')
      conn = null
      retryTimer = window.setTimeout(connect, RETRY_MS * 2)
    } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      setStatus('No connection — retrying…', 'bad')
    }
  })

  // Keepalive resend: recovers state if a message was ever missed.
  window.setInterval(send, KEEPALIVE_MS)

  // Tell the console right away when the page goes away.
  window.addEventListener('pagehide', () => conn?.close())

  // Going to the background releases everything so nothing stays held.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      dpadTouches.clear()
      setMask(0)
    } else {
      requestWakeLock()
      if (!conn?.open) connect()
    }
  })
}

// ------------------------------------------------------------------ wake lock

let wakeLock: { released: boolean } | null = null

function requestWakeLock(): void {
  const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ released: boolean }> } }).wakeLock
  if (!wl || (wakeLock && !wakeLock.released)) return
  wl.request('screen')
    .then((lock) => {
      wakeLock = lock
    })
    .catch(() => undefined)
}
