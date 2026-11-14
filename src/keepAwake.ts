// Tiny silent looping clips (MIT, from NoSleep.js). A playing <video> keeps iOS
// from auto-locking even where the Wake Lock API is missing or ineffective
// (it did nothing in Home Screen apps before iPadOS 18.4).
import media from 'nosleep.js/src/media.js'

type Sentinel = { released: boolean; release(): Promise<void>; addEventListener(t: 'release', cb: () => void): void }
type WakeLockApi = { request(type: 'screen'): Promise<Sentinel> }

/**
 * Keeps the screen on while enabled. On the iPad all input comes from the
 * phone, so without this the iPad auto-locks mid-game as if idle.
 */
export class KeepAwake {
  private enabled = false
  private sentinel: Sentinel | null = null
  private video: HTMLVideoElement | null = null

  constructor() {
    document.addEventListener('visibilitychange', () => {
      // Both the lock and the video are dropped when the page is hidden.
      if (this.enabled && document.visibilityState === 'visible') this.acquire()
    })
    // If the video wasn't allowed to start yet, the next touch starts it.
    const retry = () => this.enabled && this.acquire()
    window.addEventListener('pointerdown', retry, { capture: true })
    window.addEventListener('keydown', retry, { capture: true })
  }

  set(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) this.acquire()
    else this.releaseAll()
  }

  private acquire(): void {
    const wl = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock
    if (wl && (!this.sentinel || this.sentinel.released)) {
      wl.request('screen')
        .then((s) => {
          if (!this.enabled) return void s.release()
          this.sentinel = s
          s.addEventListener('release', () => {
            if (this.sentinel === s) this.sentinel = null
          })
        })
        .catch(() => undefined)
    }
    const v = this.ensureVideo()
    if (v.paused) v.play().catch(() => undefined)
  }

  private releaseAll(): void {
    void this.sentinel?.release().catch(() => undefined)
    this.sentinel = null
    this.video?.pause()
  }

  private ensureVideo(): HTMLVideoElement {
    if (this.video) return this.video
    const v = document.createElement('video')
    v.setAttribute('playsinline', '')
    v.setAttribute('aria-hidden', 'true')
    v.muted = true
    v.loop = true
    v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0'
    for (const [type, src] of [['video/mp4', media.mp4], ['video/webm', media.webm]] as const) {
      const s = document.createElement('source')
      s.type = type
      s.src = src
      v.appendChild(s)
    }
    document.body.appendChild(v)
    this.video = v
    return v
  }
}
