import { manifestUrl, romFileUrl } from './config'
import { getCachedRom, putCachedRom } from './db'

export interface GameEntry {
  file: string
  title: string
}

interface ManifestFile {
  games?: Array<string | { file: string; title?: string }>
}

function titleFromFile(file: string): string {
  const base = file.split('/').pop() ?? file
  return base.replace(/\.(sfc|smc|fig|swc)$/i, '').replace(/[_.]/g, ' ').trim()
}

const LIBRARY_CACHE_KEY = 'snes-library-cache'
const LIBRARY_TIMEOUT_MS = 6000

export interface Library {
  games: GameEntry[]
  /** True when the list came from the last good copy because the network failed. */
  offline: boolean
}

/**
 * The game list from the ROM repo, falling back to the last copy we saw so the
 * installed app still opens with no (or a flaky) connection.
 */
export async function fetchLibrary(): Promise<Library> {
  try {
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => ctrl.abort(), LIBRARY_TIMEOUT_MS)
    const res = await fetch(manifestUrl(), { cache: 'no-store', signal: ctrl.signal }).finally(() => window.clearTimeout(timer))
    if (!res.ok) throw new Error(`manifest.json not found in the ROM repo (HTTP ${res.status})`)
    const games = parseManifest((await res.json()) as ManifestFile | string[])
    try {
      localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(games))
    } catch {
      // best effort
    }
    return { games, offline: false }
  } catch (err) {
    const saved = loadSavedLibrary()
    if (saved) return { games: saved, offline: true }
    throw err instanceof DOMException && err.name === 'AbortError' ? new Error('No internet connection') : err
  }
}

function parseManifest(data: ManifestFile | string[]): GameEntry[] {
  const games = Array.isArray(data) ? data : (data.games ?? [])
  return games.map((g) =>
    typeof g === 'string' ? { file: g, title: titleFromFile(g) } : { file: g.file, title: g.title ?? titleFromFile(g.file) },
  )
}

function loadSavedLibrary(): GameEntry[] | null {
  try {
    const raw = localStorage.getItem(LIBRARY_CACHE_KEY)
    return raw ? (JSON.parse(raw) as GameEntry[]) : null
  } catch {
    return null
  }
}

export async function fetchRom(game: GameEntry, onProgress: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const cached = await getCachedRom(game.file)
  if (cached) return new Uint8Array(cached)

  const res = await fetch(romFileUrl(game.file))
  if (!res.ok) throw new Error(`Could not download "${game.file}" (HTTP ${res.status})`)

  const total = Number(res.headers.get('content-length')) || 0
  let body: ArrayBuffer
  if (res.body && total > 0) {
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.byteLength
      onProgress(loaded, total)
    }
    body = await new Blob(chunks as BlobPart[]).arrayBuffer()
  } else {
    body = await res.arrayBuffer()
  }

  try {
    await putCachedRom(game.file, body)
  } catch {
    // cache is best-effort; play anyway
  }
  return new Uint8Array(body)
}
