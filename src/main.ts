import './style.css'
import { MenuInput, type MenuAction } from './input'
import { fetchLibrary, fetchRom, type GameEntry } from './library'
import { exitFullscreen, Player, requestFullscreen } from './player'
import { getSaveState, listCachedRoms, putSaveState } from './db'
import { ROM_REPO } from './config'
import qrcode from 'qrcode-generator'
import { RemoteHost } from './remote/host'
import { runController } from './remote/controller'
import { PAD_PARAM } from './remote/protocol'
import { createOfferSession, QrScanner, type OfferSession } from './remote/offline'

const app = document.querySelector<HTMLDivElement>('#app')!

type Screen = 'library' | 'loading' | 'game'

let screen: Screen = 'library'
let games: GameEntry[] = []
let libraryOffline = false
let cachedRoms = new Set<string>()
let focusedIndex = 0
let currentGame: GameEntry | null = null
let hasSaveState = false

const menuInput = new MenuInput()
const player = new Player()
const remote = new RemoteHost()

function render(): void {
  if (screen === 'library') {
    renderLibrary()
  } else if (screen === 'loading') {
    // Loading screen is rendered imperatively by playGame(); keep it stable.
  }
}

// ------------------------------------------------------------- library view

function renderLibrary(): void {
  const items = games
    .map((g, i) => {
      const saved = cachedRoms.has(g.file)
      const cls = `game${i === focusedIndex ? ' focused' : ''}${libraryOffline && !saved ? ' unavailable' : ''}`
      const badge = saved ? `<span class="badge">Offline ready</span>` : ''
      return `<li><button class="${cls}" data-index="${i}"><span class="title">${escapeHtml(g.title)}</span>${badge}</button></li>`
    })
    .join('\n')

  const body =
    games.length === 0
      ? `<p class="empty">No games found.</p>`
      : `<ul class="games">${items}</ul>`

  app.innerHTML = `
    <div class="library">
      <header>
        <h1>SNES</h1>
        <p class="repo">${ROM_REPO.owner}/${ROM_REPO.repo}</p>
      </header>
      ${libraryOffline ? `<p class="offline-note">No internet — games marked “Offline ready” can still be played.</p>` : ''}
      ${body}
      ${phoneCard()}
      <footer>
        <span>Tap / A / Enter — Play</span>
        <span>D-pad — Browse</span>
        <span>In game: Start+Select (or MENU on phone) — Menu</span>
      </footer>
    </div>`
}

app.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.game')
  if (!btn) return
  const index = Number(btn.dataset.index)
  if (!Number.isNaN(index)) void playGame(games[index], true)
})

// ------------------------------------------------------------ loading state

function showLoading(title: string): void {
  app.innerHTML = `
    <div class="loading">
      <h1>${escapeHtml(title)}</h1>
      <div class="spinner"></div>
      <p id="load-status">Downloading…</p>
    </div>`
}

function showError(message: string): void {
  app.innerHTML = `
    <div class="loading">
      <h1>Something went wrong</h1>
      <p class="error">${escapeHtml(message)}</p>
      <p class="hint">Press B or Escape to go back.</p>
    </div>`
  screen = 'library'
}

// ---------------------------------------------------------------- game view

// ------------------------------------------------------- phone controller

let qrSvgCache: { url: string; svg: string } | null = null

function qrSvg(url: string): string {
  if (qrSvgCache?.url !== url) {
    const qr = qrcode(0, 'M')
    qr.addData(url)
    qr.make()
    qrSvgCache = { url, svg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }
  }
  return qrSvgCache.svg
}

function phoneStatusText(): string {
  if (remote.phoneCount > 0) {
    const n = remote.phoneCount === 1 ? '1 phone connected' : `${remote.phoneCount} phones connected`
    return remote.status === 'offline' ? `${n} · no internet, controller still works` : n
  }
  if (remote.status === 'ready') return 'Waiting for a phone…'
  if (remote.status === 'offline') return 'No internet — new phones can’t pair until it’s back'
  return 'Starting…'
}

function phoneCard(): string {
  const ready = remote.status !== 'starting'
  return `
    <section class="phone-card" id="phone-card">
      <div class="qr">${ready ? qrSvg(remote.controllerUrl) : ''}</div>
      <div class="phone-text">
        <h2>Use your iPhone as a controller</h2>
        <p>Open the Camera on your iPhone, scan this code and tap the link. Scan with a second phone for Player 2.</p>
        <p class="phone-status${remote.phoneCount > 0 ? ' ok' : ''}">${phoneStatusText()}</p>
        <button class="pair-offline-btn${remote.status === 'offline' ? ' urgent' : ''}" data-action="pair-offline">No internet? Pair without internet</button>
      </div>
    </section>`
}

function refreshPhoneCard(): void {
  const card = document.getElementById('phone-card')
  if (card) card.outerHTML = phoneCard()
}

remote.onChange = () => refreshPhoneCard()

// ------------------------------------------------- offline (QR) pairing

let offerSession: OfferSession | null = null
let offerScanner: QrScanner | null = null

document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-action="pair-offline"]')) void openOfflinePairing()
})

/**
 * iPad side of serverless pairing: show an offer QR for the phone and watch
 * the front camera for the phone's answer QR.
 */
async function openOfflinePairing(): Promise<void> {
  closeOfflinePairing()
  const overlay = document.createElement('div')
  overlay.id = 'offline-pair'
  overlay.innerHTML = `
    <div class="pair-box wide">
      <h2>Pair without internet</h2>
      <p class="lead">Both devices must be on the same network — the iPhone’s <b>Personal Hotspot</b> works best.</p>
      <div class="pair-steps">
        <div class="pair-step">
          <span class="step-n">1</span>
          <div class="pair-qr" id="offer-qr"><div class="spinner"></div></div>
          <p>Scan with the iPhone Camera, or tap <b>Pair without internet</b> in the controller and scan there.</p>
        </div>
        <div class="pair-step">
          <span class="step-n">2</span>
          <video class="pair-video mirror"></video>
          <p>Hold the code the iPhone shows up to this camera.</p>
        </div>
      </div>
      <p class="pair-msg" id="pair-msg"></p>
      <button class="pair-cancel">Close</button>
    </div>`
  document.body.appendChild(overlay)
  overlay.querySelector('.pair-cancel')!.addEventListener('click', () => closeOfflinePairing())
  const msg = (text: string) => {
    const el = document.getElementById('pair-msg')
    if (el) el.textContent = text
  }

  // Camera first: while it's on, Safari puts the iPad's real local IP into
  // the offer instead of an anonymised name, so the phone can reach it.
  const scanner = new QrScanner(overlay.querySelector('video')!)
  offerScanner = scanner
  let session: OfferSession | null = null
  const camOk = await scanner.start('user', (text) => {
    if (!session) return
    void session.accept(text).then((ok) => {
      if (ok) msg('Connecting…')
    })
  })
  if (!document.body.contains(overlay)) return scanner.stop()
  if (!camOk) msg('Camera unavailable — allow camera access for this site in Settings to finish pairing.')

  session = await createOfferSession(remote.consoleId)
  if (!document.body.contains(overlay)) return session.cancel()
  offerSession = session
  remote.accept(session.link)
  session.link.onOpen(() => {
    if (offerSession === session) offerSession = null
    closeOfflinePairing()
  })
  const qr = qrcode(0, 'M')
  qr.addData(session.url)
  qr.make()
  const box = document.getElementById('offer-qr')!
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })
  box.dataset.url = session.url
}

function closeOfflinePairing(): void {
  offerScanner?.stop()
  offerScanner = null
  offerSession?.cancel()
  offerSession = null
  document.getElementById('offline-pair')?.remove()
}
remote.onPhoneConnected = (n) => toast(`Phone connected — Player ${n}`)
remote.onPhoneDisconnected = (n) => toast(`Player ${n} phone disconnected`)

async function playGame(game: GameEntry, fromTouch = false): Promise<void> {
  if (screen !== 'library') return
  screen = 'loading'
  showLoading(game.title)
  try {
    const romBytes = await fetchRom(game, (loaded, total) => {
      const el = document.getElementById('load-status')
      if (el && total > 0) el.textContent = `Downloading… ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`
    })

    cachedRoms.add(game.file)
    const canvas = document.createElement('canvas')
    canvas.id = 'screen'
    app.innerHTML = ''
    app.appendChild(canvas)
    screen = 'game'
    currentGame = game
    hasSaveState = (await getSaveState(saveKey(game))) !== null
    stopMenuNav()

    requestFullscreen()
    await player.launch(game, romBytes, canvas)
    player.onPauseToggle = () => togglePause()
    // Started from a phone: iPadOS keeps audio muted until the screen itself
    // is touched once.
    if (!fromTouch && remote.phoneCount > 0 && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
      toast('Tap the iPad screen once to turn on sound')
    }
  } catch (err) {
    player.exit()
    const offline = !navigator.onLine || err instanceof TypeError
    showError(
      offline && !cachedRoms.has(game.file)
        ? `No internet, and “${game.title}” hasn’t been downloaded yet.\nPlay it once while you have signal and it will work offline after that.`
        : err instanceof Error
          ? err.message
          : String(err),
    )
  }
}

function saveKey(game: GameEntry): string {
  return `${game.file}:slot0`
}

// ------------------------------------------------------------ pause overlay

let paused = false

interface MenuItem {
  label: string
  action: () => void | Promise<void>
  disabled?: boolean
}

let pauseItems: MenuItem[] = []

function togglePause(): void {
  if (screen !== 'game') return
  paused ? resumeGame() : pauseGame()
}

function pauseGame(): void {
  paused = true
  player.pause()
  pauseItems = [
    { label: 'Resume', action: () => resumeGame() },
    { label: 'Save State', action: () => doSaveState() },
    { label: 'Load State', action: () => doLoadState(), disabled: !hasSaveState },
    { label: 'Reset Game', action: () => { player.reset(); resumeGame() } },
    { label: 'Exit to Library', action: () => exitToLibrary() },
  ]
  pauseIndex = Math.max(0, pauseItems.findIndex((it) => !it.disabled))
  renderPauseOverlay()
  startMenuNav(pauseMenuHandler)
}

let pauseIndex = 0

function renderPauseOverlay(): void {
  document.getElementById('pause-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.id = 'pause-overlay'
  overlay.innerHTML = `
    <div class="pause-menu">
      <h2>Paused</h2>
      <ul>
        ${pauseItems
          .map(
            (it, i) =>
              `<li><button class="${i === pauseIndex ? 'focused' : ''}"${it.disabled ? ' disabled' : ''}>${escapeHtml(it.label)}</button></li>`,
          )
          .join('\n')}
      </ul>
      <p class="hint">A — Select · B — Resume</p>
      ${phoneCard()}
    </div>`
  app.appendChild(overlay)

  overlay.querySelectorAll<HTMLButtonElement>('li button').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      if (!btn.disabled) void runPauseItem(i)
    })
  })
}

function pauseMenuHandler(action: MenuAction): void {
  if (action === 'up' || action === 'down') {
    const dir = action === 'up' ? -1 : 1
    for (let step = 0; step < pauseItems.length; step++) {
      pauseIndex = (pauseIndex + dir + pauseItems.length) % pauseItems.length
      if (!pauseItems[pauseIndex].disabled) break
    }
    renderPauseOverlay()
  } else if (action === 'select') {
    void runPauseItem(pauseIndex)
  } else if (action === 'back') {
    resumeGame()
  }
}

async function runPauseItem(index: number): Promise<void> {
  const item = pauseItems[index]
  if (!item || item.disabled) return
  await item.action()
}

function resumeGame(): void {
  if (!paused) return
  paused = false
  stopMenuNav()
  document.getElementById('pause-overlay')?.remove()
  player.resume()
}

async function doSaveState(): Promise<void> {
  if (!currentGame) return
  try {
    toast('Saving…')
    const data = await player.saveState()
    await putSaveState(saveKey(currentGame), data)
    hasSaveState = true
    toast('State saved')
  } catch (err) {
    toast(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function doLoadState(): Promise<void> {
  if (!currentGame || !hasSaveState) return
  try {
    const data = await getSaveState(saveKey(currentGame))
    if (!data) return
    await player.loadState(data)
    toast('State loaded')
    resumeGame()
  } catch (err) {
    toast(`Load failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function exitToLibrary(): void {
  paused = false
  stopMenuNav()
  player.exit()
  exitFullscreen()
  currentGame = null
  screen = 'library'
  render()
}

// ------------------------------------------------------------------- toast

let toastTimer = 0

function toast(message: string): void {
  let el = document.getElementById('toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'toast'
    app.appendChild(el)
  }
  el.textContent = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => el?.remove(), 2500)
}

// ------------------------------------------------------------ menu routing

let navHandler: ((action: MenuAction) => void) | null = null

function startMenuNav(handler: (action: MenuAction) => void): void {
  navHandler = handler
  menuInput.start((action) => {
    if (navHandler) navHandler(action)
  })
}

function stopMenuNav(): void {
  navHandler = null
  menuInput.stop()
}

function libraryNav(action: MenuAction): void {
  if (games.length === 0) return
  if (action === 'up') {
    focusedIndex = (focusedIndex - 1 + games.length) % games.length
    renderLibrary()
  } else if (action === 'down') {
    focusedIndex = (focusedIndex + 1) % games.length
    renderLibrary()
  } else if (action === 'select') {
    void playGame(games[focusedIndex])
  }
}

// -------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  screen = 'loading'
  showLoading('SNES')
  const status = document.getElementById('load-status')
  if (status) status.textContent = 'Fetching game library…'
  try {
    const lib = await fetchLibrary()
    games = lib.games
    libraryOffline = lib.offline
    cachedRoms = await listCachedRoms()
  } catch (err) {
    showError(
      `${err instanceof Error ? err.message : String(err)}\n\n` +
        `Upload your .sfc/.smc files and a manifest.json listing them to github.com/${ROM_REPO.owner}/${ROM_REPO.repo}`,
    )
    startMenuNav(() => {
      window.location.reload()
    })
    return
  }
  screen = 'library'
  render()
  startMenuNav(libraryNav)
}

const padTarget = new URLSearchParams(window.location.search).get(PAD_PARAM)
if (padTarget) {
  runController(app, padTarget)
} else {
  remote.start()
  void boot()
}

registerServiceWorker()

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then(async () => {
        const reg = await navigator.serviceWorker.ready
        // Hand over everything this page pulled in (incl. lazy chunks), so a
        // later launch with no signal finds it all in the cache.
        const sameOrigin = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((u) => u.startsWith(window.location.origin))
        reg.active?.postMessage({ type: 'cache-urls', urls: sameOrigin })
      })
      .catch(() => undefined)
  })
}

window.addEventListener('gamepadconnected', () => {
  if (screen === 'library' && games.length > 0) toast('Controller connected')
})

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
