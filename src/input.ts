export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'select' | 'back'

type ActionListener = (action: MenuAction) => void

const HELD_REPEAT_DELAY_MS = 420
const HELD_REPEAT_INTERVAL_MS = 140

interface ButtonState {
  pressed: boolean
  heldSince: number
  lastRepeat: number
}

/**
 * Edge-detecting menu input from gamepads (standard mapping) and keyboard.
 * Runs its own rAF poll; listeners fire once per press, with repeat while a
 * direction is held. Used for the ROM library and the pause overlay — never
 * during emulation, where the engine polls pads itself.
 */
export class MenuInput {
  private listener: ActionListener | null = null
  private rafId = 0
  private readonly buttons = new Map<MenuAction, ButtonState>()
  private readonly keyHeld = new Set<string>()

  start(listener: ActionListener): void {
    this.listener = listener
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    this.rafId = requestAnimationFrame(this.tick)
  }

  stop(): void {
    this.listener = null
    cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.buttons.clear()
    this.keyHeld.clear()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
  }

  private emit(action: MenuAction): void {
    this.listener?.(action)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return
    const action = keyAction(e.code)
    if (!action) return
    e.preventDefault()
    this.keyHeld.add(e.code)
    this.emit(action)
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    const action = keyAction(e.code)
    if (!action) return
    e.preventDefault()
    this.keyHeld.delete(e.code)
  }

  private tick = (): void => {
    this.rafId = requestAnimationFrame(this.tick)
    const now = performance.now()
    const active = new Set<MenuAction>(this.activeKeyActions())

    const pads = navigator.getGamepads?.() ?? []
    for (const pad of pads) {
      if (!pad?.connected) continue
      const btn = (i: number) => !!pad.buttons[i]?.pressed
      const ax = (i: number) => pad.axes[i] ?? 0
      if (btn(12) || ax(1) < -0.5) active.add('up')
      if (btn(13) || ax(1) > 0.5) active.add('down')
      if (btn(14) || ax(0) < -0.5) active.add('left')
      if (btn(15) || ax(0) > 0.5) active.add('right')
      if (btn(0)) active.add('select')
      if (btn(1)) active.add('back')
    }

    for (const action of active) {
      const st = this.buttons.get(action)
      if (!st) {
        this.buttons.set(action, { pressed: true, heldSince: now, lastRepeat: now })
        this.emit(action)
      } else if (isDirectional(action)) {
        const sinceLast = now - (st.lastRepeat ?? st.heldSince)
        const delay = now - st.heldSince < HELD_REPEAT_DELAY_MS ? HELD_REPEAT_DELAY_MS : HELD_REPEAT_INTERVAL_MS
        if (sinceLast >= delay) {
          st.lastRepeat = now
          this.emit(action)
        }
      }
    }
    for (const [action] of this.buttons) {
      if (!active.has(action)) this.buttons.delete(action)
    }
  }

  private activeKeyActions(): MenuAction[] {
    const out: MenuAction[] = []
    for (const code of this.keyHeld) {
      const action = keyAction(code)
      if (action && isDirectional(action)) out.push(action)
    }
    return out
  }
}

function isDirectional(action: MenuAction): boolean {
  return action === 'up' || action === 'down' || action === 'left' || action === 'right'
}

function keyAction(code: string): MenuAction | null {
  switch (code) {
    case 'ArrowUp':
    case 'KeyW':
      return 'up'
    case 'ArrowDown':
    case 'KeyS':
      return 'down'
    case 'ArrowLeft':
    case 'KeyA':
      return 'left'
    case 'ArrowRight':
    case 'KeyD':
      return 'right'
    case 'Enter':
    case 'Space':
      return 'select'
    case 'Escape':
    case 'Backspace':
      return 'back'
    default:
      return null
  }
}
