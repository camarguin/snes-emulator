import './style.css'
import { MenuInput, type MenuAction } from './input'
import { fetchLibrary, fetchRom, type GameEntry } from './library'
import { exitFullscreen, Player, requestFullscreen } from './player'
import { getSaveState, putSaveState } from './db'
import { ROM_REPO } from './config'

const app = document.querySelector<HTMLDivElement>('#app')!

type Screen = 'library' | 'loading' | 'game'

let screen: Screen = 'library'
let games: GameEntry[] = []
let focusedIndex = 0
let currentGame: GameEntry | null = null
let hasSaveState = false

const menuInput = new MenuInput()
const player = new Player()

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
    .map((g, i) => `<li><button class="game${i === focusedIndex ? ' focused' : ''}" data-index="${i}">${escapeHtml(g.title)}</button></li>`)
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
      ${body}
      <footer>
        <span>A / Enter — Play</span>
        <span>D-pad — Browse</span>
        <span>In game: Start+Select — Menu</span>
      </footer>
    </div>`
}

app.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.game')
  if (!btn) return
  const index = Number(btn.dataset.index)
  if (!Number.isNaN(index)) void playGame(games[index])
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

async function playGame(game: GameEntry): Promise<void> {
  if (screen !== 'library') return
  screen = 'loading'
  showLoading(game.title)
  try {
    const romBytes = await fetchRom(game, (loaded, total) => {
      const el = document.getElementById('load-status')
      if (el && total > 0) el.textContent = `Downloading… ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`
    })

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
  } catch (err) {
    player.exit()
    showError(err instanceof Error ? err.message : String(err))
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
    games = await fetchLibrary()
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

void boot()

window.addEventListener('gamepadconnected', () => {
  if (screen === 'library' && games.length > 0) toast('Controller connected')
})

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
