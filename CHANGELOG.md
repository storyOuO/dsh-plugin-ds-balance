# Changelog

All notable changes to ds-balance.

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
