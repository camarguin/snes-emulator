/**
 * Everything the PS1 player loads. Fetched into the service worker's cache as
 * soon as PS1 games exist, so the first PS1 session can be on a train with no
 * signal (the SNES shell is precached anyway; this is ~3.5 MB more).
 */
const FILES = [
  'ps1.html',
  'emulatorjs/loader.js',
  'emulatorjs/emulator.min.js',
  'emulatorjs/emulator.min.css',
  'emulatorjs/localization/en-US.json',
  'emulatorjs/compression/extractzip.js',
  'emulatorjs/compression/extract7z.js',
  'emulatorjs/cores/reports/pcsx_rearmed.json',
  'emulatorjs/cores/pcsx_rearmed-wasm.data',
  'emulatorjs/cores/pcsx_rearmed-legacy-wasm.data',
]

export function warmPs1Cache(): void {
  if (!('serviceWorker' in navigator)) return
  const base = new URL(import.meta.env.BASE_URL, window.location.href)
  const urls = FILES.map((f) => new URL(f, base).toString())
  void navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: 'cache-urls', urls })).catch(() => undefined)
}
