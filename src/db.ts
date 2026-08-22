const DB_NAME = 'snes-app'
const DB_VERSION = 1
const ROMS_STORE = 'roms'
const STATES_STORE = 'states'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(ROMS_STORE)) db.createObjectStore(ROMS_STORE)
      if (!db.objectStoreNames.contains(STATES_STORE)) db.createObjectStore(STATES_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'))
  })
  return dbPromise
}

function withStore<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const req = run(tx.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
      }),
  )
}

export async function getCachedRom(key: string): Promise<ArrayBuffer | null> {
  const value = await withStore<ArrayBuffer | undefined>(ROMS_STORE, 'readonly', (s) => s.get(key))
  return value ?? null
}

export function putCachedRom(key: string, data: ArrayBuffer): Promise<void> {
  return withStore(ROMS_STORE, 'readwrite', (s) => s.put(data, key)).then(() => undefined)
}

export function getSaveState(key: string): Promise<Uint8Array | null> {
  return withStore<Uint8Array | undefined>(STATES_STORE, 'readonly', (s) => s.get(key)).then((v) => v ?? null)
}

export function putSaveState(key: string, data: Uint8Array): Promise<void> {
  return withStore(STATES_STORE, 'readwrite', (s) => s.put(data, key)).then(() => undefined)
}
