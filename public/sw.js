// Offline support: the app shell and emulator engine are served from this
// cache, so the installed app opens on a train with no signal. ROMs and save
// states already live in IndexedDB; the game list is kept in localStorage.
const CACHE = 'snes-shell-v2'
// Hosts may send `Vary: Origin`; module scripts carry an Origin header and
// precached copies don't, so lookups must ignore Vary or they'd always miss.
const MATCH = { ignoreVary: true }
const CORE = [
  './',
  './ps1.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './engine/snes9x.js',
  './engine/snes9x.wasm',
]
const NAV_TIMEOUT_MS = 3000

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await cache.addAll(CORE)
      // Also grab the hashed JS/CSS the current index.html points at.
      const html = await (await fetch('./', { cache: 'no-store' })).text()
      const assets = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => './' + m[1])
      await cache.addAll(assets)
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  // The page reports what it loaded (e.g. lazily imported chunks) so they work offline too.
  if (event.data?.type === 'cache-urls' && Array.isArray(event.data.urls)) {
    event.waitUntil(
      caches.open(CACHE).then((cache) =>
        Promise.all(
          event.data.urls.map((url) =>
            cache.match(url, MATCH).then((hit) => hit || cache.add(url).catch(() => undefined)),
          ),
        ),
      ),
    )
  }
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req))
  } else if (url.pathname.includes('/assets/')) {
    event.respondWith(cacheFirst(req)) // content-hashed: never changes
  } else {
    event.respondWith(staleWhileRevalidate(req))
  }
})

/**
 * Fresh page when the network is good; cached copy if it's slow or gone.
 * Each page is cached under its own path (the app shell at ./, the PS1 frame
 * at ./ps1.html), ignoring the query string (?pad=… is the same page).
 */
async function networkFirst(req) {
  const cache = await caches.open(CACHE)
  const url = new URL(req.url)
  url.search = ''
  url.hash = ''
  const key = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html') ? new URL('./', self.registration.scope).href : url.href
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAV_TIMEOUT_MS)),
    ])
    if (res.ok) cache.put(key, res.clone())
    return res
  } catch {
    return (await cache.match(key, MATCH)) || Response.error()
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(req, MATCH)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) cache.put(req, res.clone())
  return res
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(req, { ...MATCH, ignoreSearch: true })
  const update = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone())
      return res
    })
    .catch(() => undefined)
  return hit || (await update) || Response.error()
}
