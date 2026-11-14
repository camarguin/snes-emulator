import jsQR from 'jsqr'
import { channelLink, type PadLink } from './link'
import { PAD_PARAM } from './protocol'

/**
 * Pairing without any server: the two devices swap their WebRTC session
 * descriptions (which carry their local network addresses) as QR codes.
 *
 *   iPad  ── offer QR (a link) ──▶ iPhone camera
 *   iPad camera ◀── answer QR ──  iPhone
 *
 * No STUN/TURN: only local addresses are used, so this works on a phone's
 * Personal Hotspot or any Wi-Fi that lets devices see each other, with no
 * internet at all.
 */

export const OFFLINE_HASH = 'offline'
const ICE_GATHER_TIMEOUT_MS = 2500

type Kind = 'o' | 'a'

// ---------------------------------------------------------------- encoding

/** Trim an SDP to what a data-channel-only session needs, so the QR stays scannable. */
function slimSdp(sdp: string): string {
  const lines = sdp.split(/\r?\n/).filter((l) => l.length > 0)
  const cands = lines.filter((l) => l.startsWith('a=candidate:'))
  const udp = cands.filter((l) => / udp /i.test(l))
  const v4 = udp.filter((l) => !(l.split(' ')[4] ?? '').includes(':'))
  const keep = new Set(v4.length ? v4 : udp.length ? udp : cands)
  return (
    lines
      .filter((l) => {
        if (l.startsWith('a=candidate:')) return keep.has(l)
        return !/^a=(extmap-allow-mixed|msid-semantic|ice-options)/.test(l)
      })
      .join('\r\n') + '\r\n'
  )
}

async function deflate(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

function toB64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string): Uint8Array {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/**
 * Compact form (`c`): just what differs between sessions — ICE credentials,
 * the DTLS fingerprint and the candidate addresses — about a third the size
 * of even a deflated SDP, so the QR stays coarse enough for a phone camera
 * pointed at a glossy screen. The SDP is rebuilt from a fixed template.
 */
function compact(kind: Kind, sdp: string): string | null {
  const get = (re: RegExp) => re.exec(sdp)?.[1]
  const ufrag = get(/^a=ice-ufrag:(\S+)/m)
  const pwd = get(/^a=ice-pwd:(\S+)/m)
  const fp = get(/^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/m)
  if (!ufrag || !pwd || !fp || /~/.test(ufrag + pwd)) return null
  if (get(/^a=mid:(\S+)/m) !== '0' || get(/^a=sctp-port:(\d+)/m) !== '5000') return null
  const fpBytes = Uint8Array.from(fp.split(':'), (h) => parseInt(h, 16))
  const cands: string[] = []
  for (const line of slimSdp(sdp).split('\r\n')) {
    const f = line.startsWith('a=candidate:') ? line.split(' ') : null
    if (!f || f[2].toLowerCase() !== 'udp') continue
    const typ = f[7] === 'host' ? 'h' : f[7] === 'srflx' ? 's' : f[7] === 'prflx' ? 'p' : null
    if (typ) cands.push(`${typ}${f[4]}:${f[5]}`)
  }
  if (!cands.length) return null
  return `${kind}c.${[ufrag, pwd, toB64url(fpBytes), ...cands].join('~')}`
}

function expand(kind: Kind, body: string): string | null {
  const [ufrag, pwd, fpB64, ...cands] = body.split('~')
  if (!ufrag || !pwd || !fpB64 || !cands.length) return null
  const fp = Array.from(fromB64url(fpB64), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
  const lines = [
    'v=0',
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
  ]
  cands.forEach((c, i) => {
    const m = /^([hsp])(.+):(\d+)$/.exec(c)
    if (!m) return
    const typ = m[1] === 'h' ? 'host' : m[1] === 's' ? 'srflx' : 'prflx'
    const priority = 2122260223 - i * 256
    lines.push(`a=candidate:${i + 1} 1 udp ${priority} ${m[2]} ${m[3]} typ ${typ}${typ === 'host' ? '' : ' raddr 0.0.0.0 rport 0'}`)
  })
  lines.push(
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${kind === 'o' ? 'actpass' : 'active'}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  )
  return lines.join('\r\n') + '\r\n'
}

/** `<kind><c|z|p>.<data>` — c = compact, z = deflated SDP, p = plain SDP. */
async function encode(kind: Kind, sdp: string): Promise<string> {
  const c = compact(kind, sdp)
  if (c) return c
  const slim = slimSdp(sdp)
  const z = await deflate(slim)
  return z ? `${kind}z.${toB64url(z)}` : `${kind}p.${toB64url(new TextEncoder().encode(slim))}`
}

async function decode(kind: Kind, code: string): Promise<string | null> {
  const m = /^([oa])([czp])\.([A-Za-z0-9_~.:+/-]+)$/.exec(code.trim())
  if (!m || m[1] !== kind) return null
  try {
    if (m[2] === 'c') return expand(kind, m[3])
    const bytes = fromB64url(m[3])
    const sdp = m[2] === 'z' ? await inflate(bytes) : new TextDecoder().decode(bytes)
    return sdp.startsWith('v=0') ? sdp : null
  } catch {
    return null
  }
}

/** Pulls an offer code out of whatever was scanned: our link, or a bare code. */
export function extractOfferCode(text: string): string | null {
  const trimmed = text.trim()
  if (/^o[czp]\./.test(trimmed)) return trimmed
  try {
    const hash = new URL(trimmed).hash.replace(/^#/, '')
    const code = new URLSearchParams(hash).get(OFFLINE_HASH)
    return code && /^o[czp]\./.test(code) ? code : null
  } catch {
    return null
  }
}

// --------------------------------------------------------------- sessions

function newConnection(): { pc: RTCPeerConnection; dc: RTCDataChannel } {
  const pc = new RTCPeerConnection({ iceServers: [] })
  // Pre-negotiated channel: both sides create it with the same id, so no
  // extra signalling round-trip is needed.
  const dc = pc.createDataChannel('pad', { negotiated: true, id: 0, ordered: true })
  return { pc, dc }
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => pc.iceGatheringState === 'complete' && done()
    pc.addEventListener('icegatheringstatechange', check)
    window.setTimeout(done, ICE_GATHER_TIMEOUT_MS)
  })
}

export interface OfferSession {
  /** Link to put in the QR code; opening it on a phone starts pairing. */
  url: string
  link: PadLink
  /** Feed it the phone's answer code; resolves false if it isn't one. */
  accept(answerCode: string): Promise<boolean>
  cancel(): void
}

/** Console side: create an offer that a phone can answer. */
export async function createOfferSession(consoleId: string): Promise<OfferSession> {
  const { pc, dc } = newConnection()
  await pc.setLocalDescription(await pc.createOffer())
  await gathered(pc)
  const code = await encode('o', pc.localDescription!.sdp)

  const url = new URL(window.location.href)
  url.search = ''
  url.searchParams.set(PAD_PARAM, consoleId)
  url.hash = `${OFFLINE_HASH}=${encodeURIComponent(code)}`

  let answered = false
  return {
    url: url.toString(),
    link: channelLink(pc, dc),
    async accept(answerCode) {
      if (answered) return true
      const sdp = await decode('a', answerCode)
      if (!sdp) return false
      answered = true
      await pc.setRemoteDescription({ type: 'answer', sdp })
      return true
    },
    cancel() {
      if (!answered || dc.readyState !== 'open') {
        dc.close()
        pc.close()
      }
    },
  }
}

export interface AnswerSession {
  /** Code to show as a QR for the console's camera. */
  code: string
  link: PadLink
}

/** Phone side: answer a scanned offer. */
export async function answerOffer(offerCode: string): Promise<AnswerSession | null> {
  const sdp = await decode('o', offerCode)
  if (!sdp) return null
  const { pc, dc } = newConnection()
  await pc.setRemoteDescription({ type: 'offer', sdp })
  await pc.setLocalDescription(await pc.createAnswer())
  await gathered(pc)
  return { code: await encode('a', pc.localDescription!.sdp), link: channelLink(pc, dc) }
}

// ----------------------------------------------------------------- camera

/**
 * Camera QR reader. Having the camera on also matters for the connection:
 * while it is, Safari reveals the device's real local IP instead of an
 * anonymised name, which the other device can then reach directly.
 */
export class QrScanner {
  private stream: MediaStream | null = null
  private timer = 0
  private readonly canvas = document.createElement('canvas')
  private readonly video: HTMLVideoElement

  constructor(video: HTMLVideoElement) {
    this.video = video
    video.setAttribute('playsinline', '')
    video.muted = true
  }

  async start(facing: 'user' | 'environment', onCode: (text: string) => void): Promise<boolean> {
    this.stop()
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
    } catch {
      return false
    }
    this.video.srcObject = this.stream
    await this.video.play().catch(() => undefined)
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
    const tick = () => {
      this.timer = window.setTimeout(tick, 150)
      const w = this.video.videoWidth
      const h = this.video.videoHeight
      if (!w || !h) return
      const scale = Math.min(1, 800 / w)
      this.canvas.width = Math.round(w * scale)
      this.canvas.height = Math.round(h * scale)
      ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height)
      const img = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
      const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
      if (hit?.data) onCode(hit.data)
    }
    tick()
    return true
  }

  stop(): void {
    window.clearTimeout(this.timer)
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.srcObject = null
  }
}
