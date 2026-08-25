# Changelog

All notable changes to ds-balance.

## 0.2.4 — unreleased

- **Align the sidebar widget's type scale with the dsh web theme**: font sizes
  now reference the theme's `--dsw-font-*-font-size` tokens (with px
  fallbacks), so they track the UI layer instead of being hard-coded; the
  collapsed-rail size rises from 10 px to the UI minimum 11 px.

## 0.2.3 — 2026-08-25

- **Fix daily rollover reading the wrong clock**: the day boundary is now the
  host machine's LOCAL calendar date (`getFullYear/getMonth/getDate`) instead
  of the UTC date from `toISOString()`, which lags the local day by the
  timezone offset (up to 8 h for UTC+8) and kept the new day's spend inside
  yesterday's "今日消耗" until 08:00 local.
- **Roll the day proactively**: the 60 s balance poll and the `/api/ds-balance`
  route now check the calendar too, so the sidebar resets at local midnight
  even with zero new LLM calls (previously only usage records or a restart
  triggered the rollover).
- Make the verification test timezone- and date-independent (pins `TZ=UTC`,
  derives the expected day string dynamically).

## 0.2.2 — 2026-08-25

- **Bundle install**: declare `dsh.bundle` and ship `cordis.patch.yml`, so the
  plugin installs through the official path (`dsh plugin --profile web add
  ds-balance`) — also the requirement for listing in the community plugin
  market. The by-name `cordis.patch.yml` wiring keeps working unchanged.
- Add a bundle-patch validity test and CI (tests on push/PR).
- Privacy: LICENSE copyright aligned to `storyOuO`; the npm `author` field no
  longer carries a personal email.

## 0.2.0 — 2026-08-25

- Initial standalone release: dual-face dsh plugin (cordis host half +
  sidebar client half) tracking DeepSeek API balance and per-call cost.
- Durable per-call ledger from real `usage` chunks, Beijing peak/off-peak ×2
  pricing, 60 s balance polling, `.bak` ledger recovery, daily history
  archiving.
