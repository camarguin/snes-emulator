import { load as loadSnes9x } from '@wasm-gaming/snes9x-wasm'
import type { GameEntry } from './library'

interface EngineHandle {
  start(): void
  pause(): void
  resume(): void
  reset(): void
  saveState(): Promise<Uint8Array>
  loadState(data: Uint8Array): Promise<void>
  destroy(): void
}

const base = import.meta.env.BASE_URL

function sanitizeNamespace(file: string): string {
  const stem = file.split('/').pop() ?? file
  return stem.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'game'
}

export class Player implements GamePlayer {
  private engine: EngineHandle | null = null
  private stopComboWatch: (() => void) | null = null
  onPauseToggle: (() => void) | null = null

  async launch(game: GameEntry, romBytes: Uint8Array, canvas: HTMLCanvasElement): Promise<void> {
    this.engine = (await (
      loadSnes9x as unknown as (cfg: Record<string, unknown>) => Promise<EngineHandle>
    )({
      canvasEl: canvas,
      assets: { rom: romBytes },
      options: { region: 'auto', aspect: '4:3', renderFilter: 'pixelated', escMenu: false, gamepads: true },
      storageNamespace: sanitizeNamespace(game.file),
      persist: 'opfs',
      jsUrl: `${base}engine/snes9x.js`,
      wasmUrl: `${base}engine/snes9x.wasm`,
    })) as EngineHandle
    this.engine.start()
    this.startComboWatch()
  }

  private startComboWatch(): void {
    this.stopComboWatch = watchPauseCombo(() => this.onPauseToggle?.())
  }

  pause(): void {
    this.engine?.pause()
  }

  resume(): void {
    this.engine?.resume()
  }

  reset(): void {
    this.engine?.reset()
  }

  async saveState(): Promise<Uint8Array> {
    if (!this.engine) throw new Error('No game running')
    return this.engine.saveState()
  }

  async loadState(data: Uint8Array): Promise<void> {
    if (!this.engine) throw new Error('No game running')
    await this.engine.loadState(data)
  }

  exit(): void {
    this.stopComboWatch?.()
    this.stopComboWatch = null
    this.engine?.destroy()
    this.engine = null
  }
}

export function requestFullscreen(): void {
  document.documentElement.requestFullscreen?.().catch(() => undefined)
}

export function exitFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen()
}

/** What main.ts needs from a running game, whichever console it is. */
export interface GamePlayer {
  onPauseToggle: (() => void) | null
  pause(): void
  resume(): void
  reset(): void
  saveState(): Promise<Uint8Array>
  loadState(data: Uint8Array): Promise<void>
  exit(): void | Promise<void>
}

/**
 * Start+Select (View+Menu), the phone's Menu button (16) or Escape toggle the
 * pause overlay. Returns a stop function.
 */
export function watchPauseCombo(onToggle: () => void): () => void {
  let wasPressed = false
  let raf = 0
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape' && !e.repeat) onToggle()
  }
  window.addEventListener('keydown', onKey)
  const poll = () => {
    raf = requestAnimationFrame(poll)
    let pressed = false
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad?.connected) continue
      if ((!!pad.buttons[8]?.pressed && !!pad.buttons[9]?.pressed) || !!pad.buttons[16]?.pressed) {
        pressed = true
        break
      }
    }
    if (pressed && !wasPressed) onToggle()
    wasPressed = pressed
  }
  raf = requestAnimationFrame(poll)
  return () => {
    cancelAnimationFrame(raf)
    window.removeEventListener('keydown', onKey)
  }
}
