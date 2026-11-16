import { watchPauseCombo, type GamePlayer } from '../player'
import type { Ps1File, Ps1Game } from './store'

/** The API public/ps1.html exposes on its window. */
interface FrameApi {
  pause(): Promise<void>
  play(): void
  reset(): void
  getState(): Uint8Array
  loadState(state: Uint8Array): void
  flushSaves(): Promise<void>
  focus(): void
}

const base = import.meta.env.BASE_URL
const START_TIMEOUT_MS = 90_000

/**
 * PS1 via EmulatorJS, inside an iframe (public/ps1.html). Throwing the frame
 * away on exit is the only reliable way to free a 500 MB disc image and the
 * emulator's heap; it also keeps EmulatorJS's globals out of the app.
 */
export class Ps1Player implements GamePlayer {
  onPauseToggle: (() => void) | null = null
  private frame: HTMLIFrameElement | null = null
  private stopCombo: (() => void) | null = null

  private get api(): FrameApi | null {
    return (this.frame?.contentWindow as (Window & { ps1?: FrameApi }) | null)?.ps1 ?? null
  }

  /** Resolves once the game is running; rejects if it never starts. */
  launch(game: Ps1Game, bios: Ps1File | null, container: HTMLElement): Promise<void> {
    const named = (f: Ps1File) => (f.file instanceof File && f.file.name === f.name ? f.file : new File([f.file], f.name))
    const extra: Record<string, File> = {}
    for (const f of game.extra) extra[`/${f.name}`] = named(f)
    ;(window as Window & { __ps1Launch?: unknown }).__ps1Launch = {
      title: game.title,
      main: named(game.main),
      extra,
      bios: bios ? named(bios) : null,
    }

    const frame = document.createElement('iframe')
    frame.id = 'ps1-frame'
    frame.src = `${base}ps1.html`
    frame.allow = 'autoplay; fullscreen; gamepad'
    container.appendChild(frame)
    this.frame = frame
    this.stopCombo = watchPauseCombo(() => this.onPauseToggle?.())
    // Keys pressed inside the frame don't reach our window; forward Escape.
    frame.addEventListener('load', () => {
      frame.contentWindow?.addEventListener('keydown', (e) => {
        if (e.code === 'Escape' && !e.repeat) this.onPauseToggle?.()
      })
    })

    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener('ps1:started', onStart)
        reject(new Error('The PS1 game didn’t start. The file may be damaged, or this game may need a real PS1 BIOS.'))
      }, START_TIMEOUT_MS)
      const onStart = () => {
        window.clearTimeout(timer)
        window.removeEventListener('ps1:started', onStart)
        resolve()
      }
      window.addEventListener('ps1:started', onStart)
    })
  }

  pause(): void {
    void this.api?.pause()
  }

  resume(): void {
    this.api?.play()
    this.api?.focus()
  }

  reset(): void {
    this.api?.reset()
  }

  async saveState(): Promise<Uint8Array> {
    const api = this.api
    if (!api) throw new Error('No game running')
    return new Uint8Array(api.getState())
  }

  async loadState(data: Uint8Array): Promise<void> {
    const api = this.api
    if (!api) throw new Error('No game running')
    api.loadState(data)
  }

  /** Writes the memory card out before the frame (and its memory) goes away. */
  async exit(): Promise<void> {
    this.stopCombo?.()
    this.stopCombo = null
    const frame = this.frame
    this.frame = null
    if (!frame) return
    try {
      await (frame.contentWindow as (Window & { ps1?: FrameApi }) | null)?.ps1?.flushSaves()
    } catch {
      // the frame may never have started
    }
    frame.remove()
    delete (window as Window & { __ps1Launch?: unknown }).__ps1Launch
  }
}
