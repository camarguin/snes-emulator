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

export async function fetchLibrary(): Promise<GameEntry[]> {
  const res = await fetch(manifestUrl(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`manifest.json not found in the ROM repo (HTTP ${res.status})`)
  const data = (await res.json()) as ManifestFile | string[]
  const games = Array.isArray(data) ? data : (data.games ?? [])
  return games.map((g) =>
    typeof g === 'string' ? { file: g, title: titleFromFile(g) } : { file: g.file, title: g.title ?? titleFromFile(g.file) },
  )
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
