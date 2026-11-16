import './style.css'
import { MenuInput, type MenuAction } from './input'
import { fetchLibrary, fetchRom, type GameEntry } from './library'
import { exitFullscreen, Player, requestFullscreen, type GamePlayer } from './player'
import { Ps1Player } from './ps1/player'
import { deletePs1Game, getBios, importPs1Files, listPs1Games, PS1_ACCEPT, type Ps1Game } from './ps1/store'
import { warmPs1Cache } from './ps1/assets'
import { getSaveState, listCachedRoms, putSaveState } from './db'
import { ROM_REPO } from './config'
import qrcode from 'qrcode-generator'
import { RemoteHost } from './remote/host'
import { KeepAwake } from './keepAwake'
import { runController, savedConsoleId } from './remote/controller'
import { PAD_PARAM } from './remote/protocol'
import { createOfferSession, describeAddresses, QrScanner, unreachableHint, type OfferSession } from './remote/offline'

const app = document.querySelector<HTMLDivElement>('#app')!

type Screen = 'library' | 'loading' | 'game'

/** One row of the library, whichever console it's for. */
type Entry = { system: 'snes'; game: GameEntry } | { system: 'ps1'; game: Ps1Game }

let screen: Screen = 'library'
let games: GameEntry[] = []
let ps1Games: Ps1Game[] = []
let biosName: string | null = null
let snesError: string | null = null
let ps1Notice: string | null = null
let libraryOffline = false
let cachedRoms = new Set<string>()
let focusedIndex = 0
let currentGame: Entry | null = null
let hasSaveState = false

const menuInput = new MenuInput()
const snesPlayer = new Player()
const ps1Player = new Ps1Player()
/** Whichever player is running the current game. */
let player: GamePlayer = snesPlayer

function entries(): Entry[] {
  return [
    ...games.map((game): Entry => ({ system: 'snes', game })),
    ...ps1Games.map((game): Entry => ({ system: 'ps1', game })),
  ]
}
const remote = new RemoteHost()
const keepAwake = new KeepAwake()

/** Screen stays on while playing, or while a phone is driving the menus. */
function updateKeepAwake(): void {
  keepAwake.set(screen === 'game' || remote.phoneCount > 0)
}

function render(): void {
  if (screen === 'library') {
    renderLibrary()
  } else if (screen === 'loading') {
    // Loading screen is rendered imperatively by playGame(); keep it stable.
  }
}

// ------------------------------------------------------------- library view

function renderLibrary(): void {
  const list = entries()
  focusedIndex = Math.min(focusedIndex, Math.max(0, list.length - 1))
  const row = (e: Entry, i: number) => {
    const focused = i === focusedIndex ? ' focused' : ''
    if (e.system === 'snes') {
      const saved = cachedRoms.has(e.game.file)
      const cls = `game${focused}${libraryOffline && !saved ? ' unavailable' : ''}`
      const badge = saved ? `<span class="badge">Offline ready</span>` : ''
      return `<li><button class="${cls}" data-index="${i}"><span class="title">${escapeHtml(e.game.title)}</span>${badge}</button></li>`
    }
    const mb = `${Math.round(e.game.size / 1e6)} MB`
    return `<li class="ps1-row"><button class="game${focused}" data-index="${i}"><span class="title">${escapeHtml(e.game.title)}</span><span class="badge">On this iPad · ${mb}</span></button><button class="remove" data-remove="${escapeHtml(e.game.id)}" aria-label="Remove ${escapeHtml(e.game.title)}">✕</button></li>`
  }
  const snesRows = list.map((e, i) => (e.system === 'snes' ? row(e, i) : '')).join('')
  const ps1Rows = list.map((e, i) => (e.system === 'ps1' ? row(e, i) : '')).join('')

  app.innerHTML = `
    <div class="library">
      <header>
        <h1>SNES</h1>
        <p class="repo">${ROM_REPO.owner}/${ROM_REPO.repo}</p>
      </header>
      ${isPhone() ? `<a class="use-as-pad" href="?${PAD_PARAM}=scan">Use this phone as a controller</a>` : ''}
      ${libraryOffline ? `<p class="offline-note">No internet — games marked “Offline ready” can still be played.</p>` : ''}
      <div class="games">
        <h2 class="section">Super Nintendo</h2>
        <div class="col">
          ${snesError ? `<p class="empty">${escapeHtml(snesError)}</p>` : games.length ? `<ul>${snesRows}</ul>` : `<p class="empty">No games found.</p>`}
        </div>
        <h2 class="section">PlayStation</h2>
        <div class="col">
          ${ps1Notice ? `<p class="ps1-notice">${escapeHtml(ps1Notice)}</p>` : ''}
          ${ps1Games.length ? `<ul>${ps1Rows}</ul>` : `<p class="empty small">No PlayStation games yet. Copy them to this iPad (AirDrop or iCloud Drive), then add them here — they stay on the iPad and play offline.</p>`}
          <div class="ps1-actions">
            <button class="add-ps1" data-action="add-ps1">+ Add PS1 games from Files</button>
            <span class="bios-status">BIOS: ${biosName ? escapeHtml(biosName) : 'built-in (add a real one with the same button for better compatibility)'}</span>
          </div>
          <input type="file" id="ps1-input" multiple accept="${PS1_ACCEPT}" hidden />
        </div>
      </div>
      ${phoneCard()}
      <footer>
        <span>Tap / A / Enter — Play</span>
        <span>D-pad — Browse</span>
        <span>In game: Start+Select (or MENU on phone) — Menu</span>
      </footer>
    </div>`
  app.querySelector<HTMLInputElement>('#ps1-input')!.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (files.length) void addPs1Games(files)
  })
  app.querySelector('.games button.focused')?.scrollIntoView({ block: 'nearest' })
}

app.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  if (target.closest('[data-action="add-ps1"]')) {
    app.querySelector<HTMLInputElement>('#ps1-input')?.click()
    return
  }
  const remove = target.closest<HTMLButtonElement>('button.remove')
  if (remove?.dataset.remove) {
    void removePs1Game(remove.dataset.remove)
    return
  }
  const btn = target.closest<HTMLButtonElement>('button.game')
  if (!btn) return
  const index = Number(btn.dataset.index)
  const entry = entries()[index]
  if (entry) void playGame(entry, true)
})

// ------------------------------------------------------------ PS1 library

async function refreshPs1(): Promise<void> {
  ps1Games = await listPs1Games()
  biosName = (await getBios())?.name ?? null
}

async function addPs1Games(files: File[]): Promise<void> {
  if (screen !== 'library') return
  screen = 'loading'
  showLoading('Adding PS1 games')
  const status = document.getElementById('load-status')
  const mb = files.reduce((n, f) => n + f.size, 0) / 1e6
  if (status) status.textContent = `Copying ${mb.toFixed(0)} MB onto this iPad… this can take a minute.`
  try {
    const res = await importPs1Files(files)
    const parts: string[] = []
    if (res.added.length) parts.push(`Added ${res.added.map((g) => `“${g.title}”`).join(', ')}.`)
    if (res.bios) parts.push('PS1 BIOS saved — it will be used for every game.')
    parts.push(...res.errors)
    ps1Notice = parts.join(' ') || null
    if (res.added.length) warmPs1Cache()
  } catch (err) {
    ps1Notice = `Couldn’t add those files: ${err instanceof Error ? err.message : String(err)}`
  }
  await refreshPs1()
  screen = 'library'
  render()
}

async function removePs1Game(id: string): Promise<void> {
  const game = ps1Games.find((g) => g.id === id)
  if (!game || !window.confirm(`Remove “${game.title}” from this iPad? Your in-game saves are kept.`)) return
  await deletePs1Game(id)
  await refreshPs1()
  ps1Notice = `Removed “${game.title}”.`
  render()
}

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
        <p>On the iPhone, open the Camera (or tap <b>SCAN</b> in the controller app) and scan this code. Scan with a second phone for Player 2.</p>
        <p class="phone-status${remote.phoneCount > 0 ? ' ok' : ''}">${phoneStatusText()}</p>
        <button class="pair-offline-btn${remote.status === 'offline' ? ' urgent' : ''}" data-action="pair-offline">No internet? Pair without internet</button>
      </div>
    </section>`
}

function refreshPhoneCard(): void {
  const card = document.getElementById('phone-card')
  if (card) card.outerHTML = phoneCard()
}

remote.onChange = () => {
  refreshPhoneCard()
  updateKeepAwake()
}

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
          <p>On the iPhone, tap <b>SCAN</b> in the controller (or use the Camera app) and point it here.</p>
        </div>
        <div class="pair-step">
          <span class="step-n">2</span>
          <video class="pair-video mirror"></video>
          <p>Then hold the code the iPhone shows up to this camera, 20–30 cm away.</p>
        </div>
      </div>
      <p class="pair-msg" id="pair-msg"></p>
      <p class="pair-diag" id="pair-diag"></p>
      <div class="pair-actions">
        <button class="pair-retry">Try again</button>
        <button class="pair-cancel">Close</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  overlay.querySelector('.pair-cancel')!.addEventListener('click', () => closeOfflinePairing())
  overlay.querySelector('.pair-retry')!.addEventListener('click', () => void openOfflinePairing())
  const msg = (text: string) => {
    const el = document.getElementById('pair-msg')
    if (el) el.textContent = text
  }
  const diag = (s: OfferSession) => {
    const el = document.getElementById('pair-diag')
    if (el)
      el.textContent =
        `This iPad: ${describeAddresses(s.localAddrs)}` +
        (s.remoteAddrs.length ? ` · iPhone: ${describeAddresses(s.remoteAddrs)}` : '')
  }

  // Camera first: while it's on, Safari puts the iPad's real local IP into
  // the offer instead of an anonymised name, so the phone can reach it.
  const scanner = new QrScanner(overlay.querySelector('video')!)
  offerScanner = scanner
  let session: OfferSession | null = null
  let answered = false
  const camOk = await scanner.start('user', (text) => {
    const s = session
    if (!s || answered) return
    void s.accept(text).then((ok) => {
      if (!ok) {
        msg('That’s not the code from the iPhone’s pairing screen.')
        return
      }
      if (answered) return
      answered = true
      msg('Got the iPhone’s code — connecting…')
      diag(s)
      // The camera stays on until we're connected: Safari only shares the
      // real local address while capture is active.
      window.setTimeout(() => {
        if (offerSession === s && !s.link.open) msg(unreachableHint(s.localAddrs, s.remoteAddrs))
      }, 15000)
    })
  })
  if (!document.body.contains(overlay)) return scanner.stop()
  if (!camOk) msg('Camera unavailable — allow camera access for this site in Settings to finish pairing.')

  session = await createOfferSession(remote.consoleId)
  if (!document.body.contains(overlay)) return session.cancel()
  offerSession = session
  const live = session
  diag(live)
  live.onState((st) => {
    if (st === 'failed' && offerSession === live) msg(unreachableHint(live.localAddrs, live.remoteAddrs))
  })
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

async function playGame(entry: Entry, fromTouch = false): Promise<void> {
  if (screen !== 'library') return
  if (entry.system === 'ps1') return playPs1(entry.game, fromTouch)
  const game = entry.game
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
    player = snesPlayer
    remote.setSystem('snes')
    screen = 'game'
    updateKeepAwake()
    currentGame = entry
    hasSaveState = (await getSaveState(saveKey(entry))) !== null
    stopMenuNav()

    requestFullscreen()
    await snesPlayer.launch(game, romBytes, canvas)
    snesPlayer.onPauseToggle = () => togglePause()
    soundHint(fromTouch)
  } catch (err) {
    snesPlayer.exit()
    remote.setSystem('snes')
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

async function playPs1(game: Ps1Game, fromTouch: boolean): Promise<void> {
  screen = 'game'
  app.innerHTML = ''
  const host = document.createElement('div')
  host.id = 'ps1-host'
  app.appendChild(host)
  player = ps1Player
  remote.setSystem('ps1')
  updateKeepAwake()
  currentGame = { system: 'ps1', game }
  hasSaveState = (await getSaveState(saveKey(currentGame))) !== null
  stopMenuNav()
  requestFullscreen()
  ps1Player.onPauseToggle = () => togglePause()
  try {
    await ps1Player.launch(game, await getBios(), host)
    soundHint(fromTouch)
  } catch (err) {
    await ps1Player.exit()
    remote.setSystem('snes')
    currentGame = null
    updateKeepAwake()
    showError(err instanceof Error ? err.message : String(err))
  }
}

/** Started from a phone: iPadOS keeps audio muted until the screen itself is touched once. */
function soundHint(fromTouch: boolean): void {
  if (!fromTouch && remote.phoneCount > 0 && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
    toast('Tap the iPad screen once to turn on sound')
  }
}

function saveKey(entry: Entry): string {
  return entry.system === 'snes' ? `${entry.game.file}:slot0` : `ps1:${entry.game.id}:slot0`
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

async function exitToLibrary(): Promise<void> {
  paused = false
  stopMenuNav()
  if (player === ps1Player) toast('Saving memory card…')
  await player.exit()
  remote.setSystem('snes')
  exitFullscreen()
  currentGame = null
  screen = 'library'
  updateKeepAwake()
  render()
  startMenuNav(libraryNav)
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
  const list = entries()
  if (list.length === 0 || screen !== 'library') return
  if (action === 'up') {
    focusedIndex = (focusedIndex - 1 + list.length) % list.length
    renderLibrary()
  } else if (action === 'down') {
    focusedIndex = (focusedIndex + 1) % list.length
    renderLibrary()
  } else if (action === 'select') {
    void playGame(list[focusedIndex])
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
    // PS1 games live on the iPad, so a missing SNES list isn't fatal.
    snesError =
      `${err instanceof Error ? err.message : String(err)}. ` +
      `Upload .sfc/.smc files and a manifest.json to github.com/${ROM_REPO.owner}/${ROM_REPO.repo}.`
  }
  await refreshPs1()
  if (ps1Games.length && navigator.onLine) warmPs1Cache()
  screen = 'library'
  render()
  startMenuNav(libraryNav)
}

const padParam = new URLSearchParams(window.location.search).get(PAD_PARAM)
if (padParam !== null) {
  // `?pad=<id>` pairs with that iPad; `?pad=` (or `scan`) opens the scanner.
  runController(app, padParam && padParam !== 'scan' ? padParam : savedConsoleId())
} else if (isPhone() && isStandalone() && savedConsoleId()) {
  // The iPhone's Home Screen app, after it has paired once: straight to the pad.
  runController(app, savedConsoleId())
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

function isPhone(): boolean {
  return matchMedia('(pointer: coarse) and ((max-width: 600px) or (max-height: 500px))').matches
}

function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
