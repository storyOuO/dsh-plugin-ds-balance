/**
 * Beijing peak-window boundary coverage for the ×2 pricing: feeds fake
 * llm/stream calls at timestamps around every edge of the official peak
 * windows (Mon–Fri 09:00–12:00 and 14:00–18:00, UTC+8) plus weekend
 * samples, and asserts the per-call cost is ×1 off-peak and ×2 in-peak.
 * Each case runs in its own scratch DSH_HOME so the durable state never
 * leaks between cases (the host half keeps an in-memory copy of its file).
 * Run: node test/peak-windows.test.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const homes = []
const home = mkdtempSync(join(tmpdir(), 'ds-balance-peak-'))
homes.push(home)
process.env.DSH_HOME = home
// Deterministic timezone: the daily rollover follows the LOCAL clock, so pin
// local == UTC (peak windows themselves are pinned to UTC+8 internally and
// are timezone-independent).
process.env.TZ = 'UTC'
delete process.env.DEEPSEEK_API_KEY
writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-test\n', 'utf8')
globalThis.fetch = async () => { throw new Error('net-blocked') }

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

let streamListener
const ctx = {
  on(event, cb) {
    if (event === 'llm/stream') streamListener = cb
  },
  webServer: { register() {} },
  get() { return undefined },
}

// 1000 input tokens at the built-in deepseek-v4-flash off-peak input price
// 1.5 CNY/1M tokens → 0.0015 CNY per call; ×2 inside a peak window.
const OFF_PEAK_COST = (1000 * 1.5) / 1e6
const usage = { inputTokens: 1000 }

const fakeStream = {
  async *[Symbol.asyncIterator]() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: 'stop' }
  },
}

// [label, Beijing-time instant (as UTC epoch ms), expected multiplier]
// 2026-08-22/23/24/25 are Sat/Sun/Mon/Tue.
const CASES = [
  ['Tue 08:59 BJT — before the morning window', Date.UTC(2026, 7, 25, 0, 59), 1],
  ['Tue 09:00 BJT — morning window opens', Date.UTC(2026, 7, 25, 1, 0), 2],
  ['Tue 11:59 BJT — last in-window minute', Date.UTC(2026, 7, 25, 3, 59), 2],
  ['Tue 12:00 BJT — lunch break starts', Date.UTC(2026, 7, 25, 4, 0), 1],
  ['Tue 13:59 BJT — lunch break', Date.UTC(2026, 7, 25, 5, 59), 1],
  ['Tue 14:00 BJT — afternoon window opens', Date.UTC(2026, 7, 25, 6, 0), 2],
  ['Tue 17:59 BJT — last in-window minute', Date.UTC(2026, 7, 25, 9, 59), 2],
  ['Tue 18:00 BJT — afternoon window closes', Date.UTC(2026, 7, 25, 10, 0), 1],
  ['Tue 20:00 BJT — evening off-peak', Date.UTC(2026, 7, 25, 12, 0), 1],
  ['Sat 10:00 BJT — weekend morning', Date.UTC(2026, 7, 22, 2, 0), 1],
  ['Sun 15:00 BJT — weekend afternoon', Date.UTC(2026, 7, 23, 7, 0), 1],
  ['Mon 09:00 BJT — Monday peak', Date.UTC(2026, 7, 24, 1, 0), 2],
]

const realDateNow = Date.now
let allOk = true

for (const [label, t, mult] of CASES) {
  const caseHome = mkdtempSync(join(tmpdir(), 'ds-balance-peak-'))
  homes.push(caseHome)
  process.env.DSH_HOME = caseHome
  writeFileSync(join(caseHome, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-test\n', 'utf8')

  Date.now = () => t
  mod.apply(ctx, {}) // built-in defaults only

  const wrapped = await streamListener({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }, () => fakeStream)
  for await (const _chunk of wrapped) { /* consume */ }

  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const state = JSON.parse(readFileSync(join(caseHome, 'storages', 'ds-balance.json'), 'utf8'))
  const expected = OFF_PEAK_COST * mult
  const ok = Math.abs(state.todayCost - expected) < 1e-9 && state.usage.length === 1
  allOk = allOk && ok
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} → ×${mult}: ${state.todayCost} (expected ${expected})`)
}

Date.now = realDateNow
for (const h of homes) rmSync(h, { recursive: true, force: true })
if (!allOk) process.exit(1)
console.log('PEAK WINDOWS OK')
process.exit(0)
