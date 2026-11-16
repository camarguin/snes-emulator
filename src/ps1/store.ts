/**
 * PS1 games picked from the iPad's Files app, kept in IndexedDB so they play
 * offline. Games are far too big for the GitHub ROM repo (300–700 MB; GitHub
 * serves at most 100 MB per file, and Releases can't be fetched by a page).
 */

export interface Ps1File {
  /** Name the emulator sees; a .cue refers to its .bin files by these names. */
  name: string
  file: Blob
}

export interface Ps1Game {
  id: string
  title: string
  /** What the emulator boots: .cue, .chd, .pbp, .iso, .bin, .zip … */
  main: Ps1File
  /** Files the main one needs next to it (the .bin tracks of a .cue). */
  extra: Ps1File[]
  size: number
  added: number
}

export interface ImportResult {
  added: Ps1Game[]
  bios: boolean
  errors: string[]
}

export const PS1_ACCEPT = '.cue,.bin,.img,.iso,.chd,.pbp,.zip,.7z,.exe'
const SINGLE_FILE = ['chd', 'pbp', 'iso', 'zip', '7z', 'exe', 'bin', 'img']
/** Every PS1 BIOS image is exactly 512 KiB; no game is that small. */
const BIOS_SIZE = 512 * 1024

const DB_NAME = 'snes-app-ps1'
const GAMES = 'games'
const MISC = 'misc'

let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(GAMES, { keyPath: 'id' })
      req.result.createObjectStore(MISC)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'))
  })
  return dbPromise
}

function run<T>(store: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(store, mode)
        const req = op(tx.objectStore(store))
        tx.oncomplete = () => resolve(req.result as T)
        tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB request failed'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
      }),
  )
}

export async function listPs1Games(): Promise<Ps1Game[]> {
  try {
    const all = await run<Ps1Game[]>(GAMES, 'readonly', (s) => s.getAll())
    return all.sort((a, b) => a.title.localeCompare(b.title))
  } catch {
    return []
  }
}

export function deletePs1Game(id: string): Promise<void> {
  return run(GAMES, 'readwrite', (s) => s.delete(id))
}

export async function getBios(): Promise<Ps1File | null> {
  try {
    return (await run<Ps1File | undefined>(MISC, 'readonly', (s) => s.get('bios'))) ?? null
  } catch {
    return null
  }
}

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''
const stem = (name: string) => name.replace(/\.[^.]+$/, '')

function titleOf(name: string): string {
  return stem(name).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Track files named in a cue sheet: `FILE "Game (Track 1).bin" BINARY`. */
function cueFiles(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*FILE\s+(?:"([^"]+)"|(\S+))/i.exec(line)
    if (m) out.push((m[1] ?? m[2]).split(/[\\/]/).pop()!)
  }
  return out
}

/**
 * Turns whatever was picked in the Files app into games: each .cue with its
 * .bin tracks, each single-file image, and a BIOS if one is among them.
 */
export async function importPs1Files(files: File[]): Promise<ImportResult> {
  const result: ImportResult = { added: [], bios: false, errors: [] }
  if ('storage' in navigator && navigator.storage.persist) void navigator.storage.persist().catch(() => false)

  const used = new Set<File>()
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]))
  const games: Ps1Game[] = []
  const make = (main: File, extra: File[]): Ps1Game => ({
    id: `${stem(main.name)}-${main.size}`,
    title: titleOf(main.name),
    main: { name: main.name, file: main },
    extra: extra.map((f) => ({ name: f.name, file: f })),
    size: main.size + extra.reduce((n, f) => n + f.size, 0),
    added: Date.now(),
  })

  // BIOS first, so a stray SCPH*.BIN isn't mistaken for a game.
  for (const f of files) {
    if (['bin', 'rom'].includes(ext(f.name)) && f.size === BIOS_SIZE) {
      await run(MISC, 'readwrite', (s) => s.put({ name: f.name, file: f }, 'bios'))
      result.bios = true
      used.add(f)
    }
  }

  for (const cue of files.filter((f) => ext(f.name) === 'cue')) {
    used.add(cue)
    const tracks = cueFiles(await cue.text())
    const found = tracks.map((n) => byName.get(n.toLowerCase()))
    const missing = tracks.filter((_, i) => !found[i])
    if (!tracks.length || missing.length) {
      result.errors.push(
        `“${cue.name}” needs ${missing.length ? missing.map((n) => `“${n}”`).join(', ') : 'its .bin file'} — select the .cue and its .bin file(s) together.`,
      )
      continue
    }
    // Keep the names the cue sheet uses (case included).
    const extra = found.map((f, i) => (f!.name === tracks[i] ? f! : new File([f!], tracks[i])))
    found.forEach((f) => used.add(f!))
    games.push(make(cue, extra))
  }

  for (const f of files) {
    if (used.has(f)) continue
    if (SINGLE_FILE.includes(ext(f.name))) games.push(make(f, []))
    else result.errors.push(`“${f.name}” isn’t a PS1 game file this app can use.`)
  }

  for (const g of games) {
    try {
      await run(GAMES, 'readwrite', (s) => s.put(g))
      result.added.push(g)
    } catch (err) {
      const full = err instanceof DOMException && err.name === 'QuotaExceededError'
      result.errors.push(
        full
          ? `Not enough space on this iPad to store “${g.title}” (${(g.size / 1e6).toFixed(0)} MB).`
          : `Couldn’t save “${g.title}”: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return result
}
