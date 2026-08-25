# ds-balance

A [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin that tracks your
**DeepSeek API balance** and **per-call cost** live in the sidebar.

It is a dual-face ("双面") dsh plugin built on the standard Cordis extension
mechanism — no private dsh APIs:

- **Host half** (`lib/index.js`, Node) wraps the `llm/stream` waterfall, prices
  every successful DeepSeek call from the provider-reported `usage` chunk into a
  durable per-call ledger, polls the official balance endpoint, and exposes a
  JSON snapshot route `/api/ds-balance`.
- **Client half** (`lib/client.js`, browser) injects an action into the
  `sidebar.footer.action` slot showing balance + today's spend (30 s polling).

> Content is DeepSeek-specific: only the `deepseek-official` provider is priced,
> and the balance endpoint / response shape (`balance_infos`, `total_balance`)
> are DeepSeek's. The **mechanism** is generic and works in any dsh profile
> (`dsh web`, headless, or this desktop shell).

## Features

- Per-call cost ledger from real `usage` chunks (durable, JSON under the dsh home).
- Daily rollover with archived per-day history.
- DeepSeek official balance polling (every 60 s) with `.bak` recovery so a torn
  write can never wipe the ledger.
- **Peak pricing**: off-peak buckets billed ×2 during Beijing peak windows
  (Mon–Fri 09:00–12:00 and 14:00–18:00, UTC+8, no DST).
- Per-model pricing overrides via the loader entry `config`.

## Install

The package declares `dsh.bundle`, so it installs through the official plugin
path (recommended):

```bash
npm install ds-balance
dsh plugin --profile web add ds-balance
```

It can also be wired by name in the profile's `cordis.patch.yml` (see
[`cordis.patch.yml.example`](./cordis.patch.yml.example)) — the bundle install
and the patch wiring are equivalent, and both keep the package resolvable by
the bare name `ds-balance`:

```yaml
- insert:
    - id: ds-balance
      name: 'ds-balance'
      config:
        pricing:
          deepseek-v4-pro:
            input: 2.0
            cacheRead: 0.5
            cacheWrite: 2.0
            output: 8.0
```

`config.pricing.<model>` overrides the default off-peak CNY-per-1M-token
buckets. `cacheWrite` defaults to `input` when omitted.

## Test

The verification script exercises the host half (pricing, ledger, credentials
key resolution, daily history, `.bak` recovery) with a mocked cordis ctx —
no network, no absolute paths:

```bash
npm test
```

## License

MIT
