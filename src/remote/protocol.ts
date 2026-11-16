/**
 * Wire format between the phone controller and the console (iPad) over a
 * WebRTC data channel brokered by PeerJS.
 *
 * Buttons are a bitmask keyed by W3C "standard" gamepad button indices, so the
 * console can expose each phone as an ordinary virtual Gamepad that the engine,
 * menus and pause combo already understand.
 */
export const BTN = {
  B: 0, // bottom face
  A: 1, // right face
  Y: 2, // left face
  X: 3, // top face
  L: 4,
  R: 5,
  SELECT: 8,
  START: 9,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  MENU: 16, // opens the pause overlay
  L2: 6, // PS1 only
  R2: 7, // PS1 only
} as const

/** Which console is running, so the phone can show the matching layout. */
export type GameSystem = 'snes' | 'ps1'

export const BUTTON_COUNT = 17

/** Gamepad.id of virtual pads, so menus can apply Nintendo-style A/B. */
export const VIRTUAL_PAD_ID = 'Phone Controller (snes-remote)'

/** Query parameter that turns the page into a controller for that console. */
export const PAD_PARAM = 'pad'

export type PhoneMessage = { t: 'in'; m: number }
export type ConsoleMessage = { t: 'hello'; player: number; system?: GameSystem } | { t: 'system'; system: GameSystem }

/**
 * PeerJS broker. Only used to introduce the two devices; button presses then
 * travel directly phone → iPad. Defaults to the free public PeerJS cloud;
 * set VITE_PEER_HOST (and optionally VITE_PEER_PORT / VITE_PEER_PATH /
 * VITE_PEER_SECURE) at build time to use a self-hosted `peer` server.
 */
export function peerOptions(): Record<string, unknown> {
  const env = import.meta.env
  const opts: Record<string, unknown> = { debug: 0 }
  if (env.VITE_PEER_HOST) {
    opts.host = env.VITE_PEER_HOST
    if (env.VITE_PEER_PORT) opts.port = Number(env.VITE_PEER_PORT)
    if (env.VITE_PEER_PATH) opts.path = env.VITE_PEER_PATH
    opts.secure = env.VITE_PEER_SECURE ? env.VITE_PEER_SECURE === 'true' : window.location.protocol === 'https:'
  }
  return opts
}
