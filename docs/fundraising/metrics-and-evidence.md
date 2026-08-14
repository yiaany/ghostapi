# Metrics And Evidence Boundary

Reviewed on 2026-08-09 from `SESSION_LOG.md`, the local CLI telemetry export, and repository verification records.

| Metric | Observed value | Source | Classification |
| --- | ---: | --- | --- |
| Root test suite | 225 passing; 8 Linux-only namespace tests skipped on Windows | Session 22, 2026-08-09 | Development verification, not customer traction |
| WSL Linux test suite | 232 passing; 1 optional test skipped | Session 22, 2026-08-09; Ubuntu WSL 2, Node.js 20.20.2, Linux filesystem copy | Development verification, not customer traction |
| Linux CI smoke demonstration | Safe run generated PASS evidence; direct `api.stripe.com` fixture failed inside the namespace as expected | Session 22, 2026-08-09 | Reproducible technical demo, not customer outcome |
| Linux enforced full suite | `ghostapi run -- npm test` completed in 48.75 seconds and generated PASS exact-run evidence | Session 22, 2026-08-09; Ubuntu WSL 2, Node.js 20.20.2 | Development verification, not a first-value benchmark or customer traction |
| Hosted-pilot tests | 7 passing | Session 21, 2026-08-08 | Development verification only |
| CI design partners | 0 | `SESSION_LOG.md` metrics table, 2026-08-04 | Observed status |
| Paying design partners | 0 | `SESSION_LOG.md` metrics table, 2026-08-04 | Observed status |
| Weekly active projects | Not measured | `SESSION_LOG.md` metrics table | Unknown |
| Prevented production egress attempts | Not measured | `SESSION_LOG.md` metrics table | Unknown |
| Confirmed bugs caught before merge | Not measured | `SESSION_LOG.md` metrics table | Unknown |
| Local telemetry counters | all zero; telemetry disabled | `ghostapi telemetry export --json`, 2026-08-09 | Local state; not an install/user metric |
| Windows local onboarding measurement | 3.03 seconds | `docs/development/onboarding-smoke.md`, 2026-08-08 | Single-host simulation measurement, not Linux enforcement or public benchmark |

## Rules For External Materials

- Label a demo as a demo. It is not a prevented incident, customer outcome, or benchmark.
- Label every future number as a **target** or **assumption** with a date and owner.
- Do not infer active users from package downloads, GitHub stars, local telemetry, workflow runs, or conversations.
- Do not use an old repository statement as customer proof without a dated, sanitized primary record.
- Do not claim an enforcement result from Windows or macOS. `ghostapi run` must succeed on a compatible Linux host, and the resulting evidence must be retained.

## Current Release Evidence

Session 22 additionally ran the full namespace suite and CI smoke workflow locally in Ubuntu WSL 2 on Node.js 20.20.2. The safe fixture produced PASS evidence with a completed Linux namespace boundary, one allowed local Stripe-shaped request, zero production attempts, no secret categories, and the required scenario. The direct `api.stripe.com` fixture failed as expected inside the loopback-only namespace. This does not substitute for the pinned GitHub Linux workflow on the exact release commit before external publication. See [release-readiness.md](../release-readiness.md).
