// Copies the emulator engines from node_modules into public/, so they're served
// from our own origin (and cached by the service worker for offline play).
import { cpSync, mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync } from 'node:fs'

const nm = 'node_modules'

// SNES: snes9x
mkdirSync('public/engine', { recursive: true })
for (const f of ['snes9x.js', 'snes9x.wasm']) {
  copyFileSync(`${nm}/@wasm-gaming/snes9x-wasm/dist/snes9x/${f}`, `public/engine/${f}`)
}

// PS1: EmulatorJS (GPL-3.0) + the PCSX-ReARMed core. Only what the PS1 player
// needs; the loader falls back from emulator.min.js to the src/ scripts.
const ejs = `${nm}/@emulatorjs/emulatorjs/data`
const out = 'public/emulatorjs'
rmSync(out, { recursive: true, force: true })
mkdirSync(`${out}/cores/reports`, { recursive: true })
for (const f of ['loader.js', 'emulator.css', 'version.json']) copyFileSync(`${ejs}/${f}`, `${out}/${f}`)
cpSync(`${ejs}/src`, `${out}/src`, { recursive: true })
cpSync(`${ejs}/compression`, `${out}/compression`, { recursive: true })
copyFileSync(`${nm}/@emulatorjs/emulatorjs/LICENSE`, `${out}/LICENSE`)
// The loader asks for emulator.min.js/.css first and only falls back to src/
// after a 404. Ship them, built by plain concatenation in the loader's order.
const order = ['emulator.js', 'nipplejs.js', 'shaders.js', 'storage.js', 'gamepad.js', 'GameManager.js', 'socket.io.min.js', 'compression.js']
writeFileSync(`${out}/emulator.min.js`, order.map((f) => readFileSync(`${ejs}/src/${f}`, 'utf8')).join('\n;\n'))
copyFileSync(`${ejs}/emulator.css`, `${out}/emulator.min.css`)
mkdirSync(`${out}/localization`, { recursive: true })
copyFileSync(`${ejs}/localization/en-US.json`, `${out}/localization/en-US.json`)
const core = `${nm}/@emulatorjs/core-pcsx_rearmed`
// Non-threaded only: threads need cross-origin isolation, which GitHub Pages can't set.
for (const f of ['pcsx_rearmed-wasm.data', 'pcsx_rearmed-legacy-wasm.data']) copyFileSync(`${core}/${f}`, `${out}/cores/${f}`)
cpSync(`${core}/reports`, `${out}/cores/reports`, { recursive: true })
