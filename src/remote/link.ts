import type { DataConnection } from 'peerjs'

/**
 * One phone ↔ console channel, whatever set it up: PeerJS (pairing through the
 * internet) or a raw RTCDataChannel (offline pairing by QR codes).
 */
export interface PadLink {
  readonly open: boolean
  send(msg: object): void
  close(): void
  onOpen(cb: () => void): void
  onData(cb: (msg: unknown) => void): void
  /** Fires once, on close or error. */
  onClose(cb: () => void): void
}

export function peerLink(conn: DataConnection): PadLink {
  return {
    get open() {
      return conn.open
    },
    send: (msg) => void conn.send(msg),
    close: () => conn.close(),
    onOpen: (cb) => (conn.open ? cb() : conn.on('open', cb)),
    onData: (cb) => conn.on('data', cb),
    onClose: (cb) => {
      let fired = false
      const once = () => {
        if (!fired) {
          fired = true
          cb()
        }
      }
      conn.on('close', once)
      conn.on('error', once)
    },
  }
}

export function channelLink(pc: RTCPeerConnection, dc: RTCDataChannel): PadLink {
  const closeCbs: Array<() => void> = []
  let closed = false
  const fireClose = () => {
    if (closed) return
    closed = true
    for (const cb of closeCbs) cb()
  }
  dc.addEventListener('close', fireClose)
  dc.addEventListener('error', fireClose)
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') fireClose()
  })
  return {
    get open() {
      return dc.readyState === 'open'
    },
    send: (msg) => {
      if (dc.readyState === 'open') dc.send(JSON.stringify(msg))
    },
    close: () => {
      dc.close()
      pc.close()
      fireClose()
    },
    onOpen: (cb) => (dc.readyState === 'open' ? cb() : dc.addEventListener('open', () => cb(), { once: true })),
    onData: (cb) =>
      dc.addEventListener('message', (e) => {
        try {
          cb(JSON.parse(String(e.data)))
        } catch {
          // ignore malformed
        }
      }),
    onClose: (cb) => (closed ? cb() : closeCbs.push(cb)),
  }
}
