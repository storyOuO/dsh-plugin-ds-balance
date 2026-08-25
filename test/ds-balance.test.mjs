/**
 * One-shot verification for the ds-balance host half (v2 pricing +
 * persistence): mocks the cordis ctx, feeds fake llm streams through the
 * wrapped waterfall listener, and checks the durable ledger under off-peak
 * and Beijing peak pricing, credentials-file key resolution, daily-history
 * archiving at rollover, and .bak recovery from a corrupted state file.
 * Run: npm test  (or: node test/ds-balance.test.mjs)
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'ds-balance-test-'))
process.env.DSH_HOME = home
// Deterministic timezone: the daily rollover follows the LOCAL clock, so pin
// local == UTC for the whole run (must be set before any Date use).
process.env.TZ = 'UTC'
delete process.env.DEEPSEEK_API_KEY

// Credentials-file resolution: a fake key must reach fetch (blocked here).
writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-test-123\n', 'utf8')
globalThis.fetch = async () => { throw new Error('net-blocked') }

// Portable import: resolves relative to this file regardless of where the
// repo is checked out (no hardcoded absolute path).
const mod = await import(new URL('../lib/index.js', import.meta.url).href)

let streamListener
const ctx = {
  on(event, cb) {
    if (event === 'llm/stream') streamListener = cb
  },
  webServer: { register() {} },
  get() { return undefined },
}

const cfg = {
  pricing: {
    'deepseek-v4-pro': { input: 4.5, cacheRead: 0.15, output: 13.5 },
    'deepseek-v4-flash': { input: 1.5, cacheRead: 0.05, output: 4.5 },
  },
}

const statePath = join(home, 'storages', 'ds-balance.json')
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))

// --- Phase 1: pricing under controlled timestamps ---
mod.apply(ctx, cfg)
if (typeof streamListener !== 'function') throw new Error('llm/stream listener was not registered')

// Off-peak (Tue 13:00 Beijing = 05:00Z) and peak (Tue 10:00 Beijing = 02:00Z).
// 2026-08-25 is a Tuesday.
const OFF_PEAK_T = Date.UTC(2026, 7, 25, 5, 0, 0)
const PEAK_T = Date.UTC(2026, 7, 25, 2, 0, 0)

const fakeStream = (usage) => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: 'stop' }
  },
})

const offPeakUsage = { inputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 300, outputTokens: 200 }
const peakUsage = { inputTokens: 2000, cacheReadTokens: 400, cacheWriteTokens: 0, outputTokens: 100 }

let nowMs = OFF_PEAK_T
const realDateNow = Date.now
Date.now = () => nowMs

let wrapped = await streamListener({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, () => fakeStream(offPeakUsage))
for await (const _chunk of wrapped) { /* consume */ }

nowMs = PEAK_T
wrapped = await streamListener({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }, () => fakeStream(peakUsage))
for await (const _chunk of wrapped) { /* consume */ }

Date.now = realDateNow

// Non-deepseek calls must be ignored.
wrapped = await streamListener({ provider: 'other', model: 'x' }, () => fakeStream(peakUsage))
for await (const _chunk of wrapped) { /* consume */ }

await new Promise((resolve) => setImmediate(resolve))
await new Promise((resolve) => setImmediate(resolve))

const p = cfg.pricing
const expectedOffPeak =
  (1000 * p['deepseek-v4-pro'].input +
    500 * p['deepseek-v4-pro'].cacheRead +
    300 * p['deepseek-v4-pro'].input + // cacheWrite falls back to input price
    200 * p['deepseek-v4-pro'].output) / 1e6
const expectedPeak =
  ((2000 * p['deepseek-v4-flash'].input +
    400 * p['deepseek-v4-flash'].cacheRead +
    0 +
    100 * p['deepseek-v4-flash'].output) /
    1e6) *
  2
const expectedTotal = expectedOffPeak + expectedPeak

let state = readState()
const costOk = Math.abs(state.todayCost - expectedTotal) < 1e-9 && state.totalCost === state.todayCost
const ledgerOk = state.usage.length === 2
const byModelOk =
  Math.abs(state.todayByModel['deepseek-v4-pro'] - expectedOffPeak) < 1e-9 &&
  Math.abs(state.todayByModel['deepseek-v4-flash'] - expectedPeak) < 1e-9
const keyOk = state.balanceError === 'net-blocked'
console.log('phase1 pricing+ledger+key:', { costOk, ledgerOk, byModelOk, keyOk, todayCost: state.todayCost })

// --- Phase 2: daily-history archiving on rollover ---
// Expected "today" is the host machine's LOCAL calendar date (same rule as
// the plugin's rollDay), computed dynamically so the test is immune to both
// the run date and the machine timezone.
const _d = new Date()
const localDay = _d.getFullYear() + '-' + String(_d.getMonth() + 1).padStart(2, '0') + '-' + String(_d.getDate()).padStart(2, '0')

// Rewind the persisted day to yesterday; the next activation must archive it.
const yesterdayState = readState()
yesterdayState.day = '2026-08-24'
writeFileSync(statePath, JSON.stringify(yesterdayState, null, 2), 'utf8')

mod.apply(ctx, cfg) // reload: rollDay archives '2026-08-24'
await new Promise((resolve) => setImmediate(resolve))
state = readState()
const historyOk =
  state.day === localDay &&
  state.history['2026-08-24'] === Math.round(expectedTotal * 10000) / 10000 &&
  state.usage.length === 0 &&
  state.todayCost === 0
console.log('phase2 history:', { historyOk, history: state.history })

// --- Phase 3: .bak recovery from a corrupted live file ---
writeFileSync(statePath, '{ definitely not json', 'utf8')
mod.apply(ctx, cfg) // loadState must fall back to the backup
await new Promise((resolve) => setImmediate(resolve))
state = readState()
const bakOk =
  state.day === localDay &&
  typeof state.history === 'object' &&
  Array.isArray(state.usage) &&
  existsSync(`${statePath}.bak`)
console.log('phase3 bak recovery:', { bakOk, day: state.day })

const allOk = costOk && ledgerOk && byModelOk && keyOk && historyOk && bakOk
rmSync(home, { recursive: true, force: true })
if (!allOk) process.exit(1)
console.log('VERIFY OK')
process.exit(0)
