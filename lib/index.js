/**
 * ds-balance — host half.
 *
 * A web-profile cordis plugin that (1) wraps the `llm/stream` waterfall to
 * price every successful DeepSeek call from the provider-reported `usage`
 * chunk into a durable per-call ledger, and (2) polls the official balance
 * endpoint `GET https://api.deepseek.com/user/balance` every minute. A tiny
 * JSON HTTP route exposes the whole snapshot to the browser half.
 *
 * Pricing (v2): every bucket is an OFF-PEAK price in CNY per 1M tokens;
 * peak hours automatically bill at ×2, matching the official rule
 * (peak = 2 × off-peak). Peak windows are Beijing time (UTC+8, no DST):
 * Mon–Fri 09:00–12:00 and 14:00–18:00; everything else is off-peak.
 * Override per model via the loader entry config:
 *   config.pricing.<model> = { input, cacheRead, cacheWrite?, output }
 * `cacheWrite` defaults to the `input` (cache-miss) price.
 *
 * Loaded from the web profile patch layer as `ds-balance`
 * (see cordis.patch.yml). Plain ESM, namespace plugin form
 * (named exports name/inject/apply), no default export.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const name = 'ds-balance'
/** Hard dependency: the web profile's HTTP route registry. */
const inject = ['webServer']

/** Default off-peak prices in CNY per 1M tokens (deepseek-v4-flash tier). */
const DEFAULT_PRICING = {
  input: 1.5,
  cacheRead: 0.05,
  output: 4.5,
}

/** Balance poll interval: 1 minute. */
const BALANCE_REFRESH_MS = 60 * 1000
/** Hard timeout for the balance request. */
const BALANCE_TIMEOUT_MS = 15_000
/** Ledger cap: drop oldest entries beyond this (≈ one busy day). */
const MAX_LEDGER_ENTRIES = 5000

/** Absolute path of the durable state file under the DSH home. */
function storagePath(env) {
  const home = env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'ds-balance.json')
}

/** Absolute path of the DSH credentials file under the DSH home. */
function credentialsPath(env) {
  const home = env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, '.credentials.yaml')
}

/**
 * Resolve the DeepSeek API key: environment first (the desktop shell injects
 * it), then the DSH credentials file (`$DSH_HOME/.credentials.yaml`, where the
 * web settings surface stores `refs.DEEPSEEK_API_KEY`). The file format is
 * stable YAML; a narrow regex parse avoids any third-party import.
 */
function resolveApiKey(env) {
  const fromEnv = (env.DEEPSEEK_API_KEY ?? '').trim()
  if (fromEnv !== '') return fromEnv
  try {
    const text = readFileSync(credentialsPath(env), 'utf8')
    const match = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m)
    if (match !== null && match[1] !== undefined) return match[1].trim()
  } catch {
    /* missing or unreadable credentials file */
  }
  return ''
}

/** Fresh state shape (v2 ledger). */
function freshState() {
  return {
    version: 2,
    day: '',
    usage: [], // { t: epochMs, m: model, i: input, cr: cacheRead, cw: cacheWrite, o: output }
    todayCost: 0,
    todayByModel: {},
    totalCost: 0,
    lastUsageAt: null,
    balance: null,
    balanceError: null,
    history: {}, // day 'YYYY-MM-DD' -> final cost that day (archived at rollover)
  }
}

/**
 * Load durable state, tolerating a missing or corrupted file; v1 migrates.
 * Falls back to the previous-good snapshot (`ds-balance.json.bak`) when the
 * live file is unreadable, so a torn write can never wipe the ledger.
 */
function loadState(file) {
  const tryRead = (path) => {
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        if (parsed !== null && typeof parsed === 'object') return parsed
      }
    } catch {
      /* fall through to the backup, then to a fresh state */
    }
    return null
  }
  const parsed = tryRead(file) ?? tryRead(`${file}.bak`)
  if (parsed !== null) {
    if (!Array.isArray(parsed.usage)) parsed.usage = []
    if (parsed.history === null || typeof parsed.history !== 'object') parsed.history = {}
    parsed.version = 2
    return parsed
  }
  return freshState()
}

/**
 * Durable whole-file replace, never throws. The previous-good file is rotated
 * to `<file>.bak` first, so recovery always has a snapshot one write behind.
 */
function saveState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    if (existsSync(file)) renameSync(file, `${file}.bak`)
    renameSync(tmp, file)
  } catch {
    /* disk full / permissions — persist silently, keep in-memory state */
  }
}

/** Round a CNY amount to 4 decimals for archived history. */
function round4(value) {
  return Math.round(value * 10000) / 10000
}

/**
 * Reset per-day counters and the ledger when the local date rolls over,
 * archiving the finished day's cost into `history`.
 */
function rollDay(state) {
  const today = new Date().toISOString().slice(0, 10)
  if (state.day !== today) {
    if (state.day !== '' && (state.todayCost ?? 0) > 0) {
      state.history[state.day] = round4(state.todayCost)
    }
    state.day = today
    state.usage = []
    state.todayCost = 0
    state.todayByModel = {}
  }
}

/**
 * Beijing-time peak windows: Mon–Fri 09:00–12:00 and 14:00–18:00 (UTC+8,
 * no DST). Evenings, nights, weekends, and 12:00–14:00 are off-peak.
 * @param epochMs - the usage record's timestamp.
 */
function isPeakHour(epochMs) {
  const bj = new Date(epochMs + 8 * 3600 * 1000)
  const dow = bj.getUTCDay()
  if (dow === 0 || dow === 6) return false
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080)
}

/** Merge loader config overrides onto the default off-peak buckets. */
function pricingFor(config, model) {
  const byModel = config?.pricing?.[model] ?? {}
  return {
    input: Number(byModel.input ?? DEFAULT_PRICING.input),
    cacheRead: Number(byModel.cacheRead ?? DEFAULT_PRICING.cacheRead),
    cacheWrite: Number(byModel.cacheWrite ?? byModel.input ?? DEFAULT_PRICING.input),
    output: Number(byModel.output ?? DEFAULT_PRICING.output),
  }
}

/**
 * Price one ledger entry in CNY: off-peak buckets at record time, ×2 when
 * the record fell in a Beijing peak window.
 */
function priceUsage(config, model, entry) {
  const p = pricingFor(config, model)
  const raw =
    ((entry.i ?? 0) * p.input +
      (entry.cr ?? 0) * p.cacheRead +
      (entry.cw ?? 0) * p.cacheWrite +
      (entry.o ?? 0) * p.output) /
    1_000_000
  return raw * (isPeakHour(entry.t) ? 2 : 1)
}

/** Recompute today's totals from the ledger under the CURRENT pricing. */
function recomputeToday(state, config) {
  const totals = {}
  let total = 0
  for (const entry of state.usage) {
    const cost = priceUsage(config, entry.m, entry)
    totals[entry.m] = (totals[entry.m] ?? 0) + cost
    total += cost
  }
  state.todayCost = total
  state.todayByModel = totals
}

/** Append one provider usage sample to the ledger and re-derive totals. */
function recordUsage(state, file, config, provider, model, usage, nowMs = Date.now()) {
  if (provider !== 'deepseek-official') return
  rollDay(state)
  const entry = {
    t: nowMs,
    m: model,
    i: usage.inputTokens ?? 0,
    cr: usage.cacheReadTokens ?? 0,
    cw: usage.cacheWriteTokens ?? 0,
    o: usage.outputTokens ?? 0,
  }
  state.usage.push(entry)
  if (state.usage.length > MAX_LEDGER_ENTRIES) {
    state.usage.splice(0, state.usage.length - MAX_LEDGER_ENTRIES)
  }
  state.totalCost = (state.totalCost ?? 0) + priceUsage(config, model, entry)
  state.lastUsageAt = nowMs
  recomputeToday(state, config)
  saveState(file, state)
}

/** Poll the official balance endpoint and update the snapshot. */
async function refreshBalance(env, state, file) {
  const key = resolveApiKey(env)
  if (key === '') {
    state.balanceError = 'no DEEPSEEK_API_KEY'
    state.balance = null
    saveState(file, state)
    return
  }
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`balance HTTP ${String(res.status)}`)
    const data = await res.json()
    const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : undefined
    state.balance = {
      currency: info?.currency ?? 'CNY',
      total: typeof info?.total_balance === 'string' ? info.total_balance : null,
      granted: typeof info?.granted_balance === 'string' ? info.granted_balance : null,
      toppedUp: typeof info?.topped_up_balance === 'string' ? info.topped_up_balance : null,
      available: data?.is_available === true,
      fetchedAt: Date.now(),
    }
    state.balanceError = null
  } catch (error) {
    state.balanceError = String(error?.message ?? error)
    if (state.balance !== null && typeof state.balance === 'object') state.balance.stale = true
  }
  saveState(file, state)
}

/** Cordis plugin entry. Config is the loader entry config (pricing overrides). */
function apply(ctx, config) {
  const cfg = config ?? {}
  const env = process.env
  const file = storagePath(env)
  const state = loadState(file)
  rollDay(state)
  recomputeToday(state, cfg)
  saveState(file, state)

  // 1) Wrap every streaming model call; append the single `usage` chunk.
  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    if (stream == null || typeof stream[Symbol.asyncIterator] !== 'function') return stream
    const provider = options.provider
    const model = options.model
    return {
      [Symbol.asyncIterator]() {
        const it = stream[Symbol.asyncIterator]()
        return {
          next: () =>
            Promise.resolve(it.next()).then((result) => {
              if (!result.done && result.value?.type === 'usage' && result.value.usage != null) {
                recordUsage(state, file, cfg, provider, model, result.value.usage)
              }
              return result
            }),
          return: (value) => (it.return != null ? it.return(value) : { done: true, value }),
          throw: (error) => (it.throw != null ? it.throw(error) : Promise.reject(error)),
        }
      },
    }
  })

  // 2) JSON snapshot route for the browser half.
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/ds-balance',
    handler: async (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(state))
    },
  })

  // 3) Periodic balance polling (every minute) + immediate first refresh.
  const timer = setInterval(() => {
    void refreshBalance(env, state, file)
  }, BALANCE_REFRESH_MS)
  ctx.on('dispose', () => clearInterval(timer))
  void refreshBalance(env, state, file)
}

export { name, inject, apply }
