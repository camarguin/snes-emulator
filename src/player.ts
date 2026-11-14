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

export class Player {
  private engine: EngineHandle | null = null
  private comboRafId = 0
  private comboWasPressed = false
  private comboKeyHandler: ((e: KeyboardEvent) => void) | null = null
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

  /** Start+Select (View+Menu) toggles the pause overlay; Escape too on desktop. */
  private startComboWatch(): void {
    this.comboKeyHandler = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && !e.repeat) this.onPauseToggle?.()
    }
    window.addEventListener('keydown', this.comboKeyHandler)
    const poll = () => {
      this.comboRafId = requestAnimationFrame(poll)
      let pressed = false
      for (const pad of navigator.getGamepads?.() ?? []) {
        if (!pad?.connected) continue
        // Start+Select, or the phone controller's dedicated Menu button (16).
        if ((!!pad.buttons[8]?.pressed && !!pad.buttons[9]?.pressed) || !!pad.buttons[16]?.pressed) {
          pressed = true
          break
        }
      }
      if (pressed && !this.comboWasPressed) this.onPauseToggle?.()
      this.comboWasPressed = pressed
    }
    this.comboRafId = requestAnimationFrame(poll)
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
    cancelAnimationFrame(this.comboRafId)
    if (this.comboKeyHandler) window.removeEventListener('keydown', this.comboKeyHandler)
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
