# Release Readiness Matrix

Last reviewed: 2026-08-22.

This matrix is a release-candidate review, not a publication approval. No Git tag, GitHub release, or npm publication was created during this review.

| Feature | Platform / boundary | Guarantee level | Evidence reviewed | Known gap | Owner before release |
| --- | --- | --- | --- | --- | --- |
| Local provider simulation, dashboard, MCP | Node.js on Windows and Ubuntu WSL2 | Local simulation only; no real provider calls by default. | Final 0.1.8 root lint and typecheck; 56 files and 342 tests with zero skipped; build; packed-package smoke; full and production audits with zero vulnerabilities. | GitHub Actions has not yet been observed on the exact final pushed commit. | Maintainer: retain the exact-commit CI results before publication. |
| `ghostapi run` | Linux only when `unshare` and `ip` preflight pass | Loopback-only user/mount/network/PID namespace; fail closed. Not a hostile-code filesystem sandbox. | Native Ubuntu WSL2 enforcement suite passed 12 of 12 tests with zero skipped on 2026-08-22, exercising the Linux namespace boundary. Earlier 0.1.7 WSL evidence remains historical. | Local WSL2 evidence is not a substitute for GitHub Actions on the exact final commit. | Maintainer: observe the pinned workflow after push and retain sanitized evidence. |
| Policy parser | Local YAML input | Bounded, one-document, no anchors/aliases/interpolation, path-contained parsing. | Unit tests plus 400 deterministic malformed-input cases. | Fuzz corpus is deterministic regression coverage, not a replacement for long-running fuzzing. | Maintainer: extend corpus when syntax support changes. |
| Evidence reports | Local files and explicit `--run` input | Bounded report/run input, secret redaction, canonical logical hash, fail-closed CI result. | Evidence tests include corruption, traversal, terminal escapes, malformed and oversized run evidence. | Same-user filesystem TOCTOU remains outside the local lock/store threat boundary. | Maintainer: document/assess before any shared filesystem support. |
| Record/replay and contract import | Local JSON/HAR/OpenAPI input | Bounded JSON only; archives, remote refs, symlinks, unsafe hosts, redirects, and secret-bearing bundles reject. | Scenario and contract suites; deterministic malformed-input coverage. | Sanitization is heuristic and requires operator review before sharing. | Maintainer: maintain provider/sanitizer regression fixtures. |
| Provider packs | Local runtime | Deterministic provider-shaped behavior; unsupported endpoints fail diagnostically. | Stripe lifecycle/conformance tests and provider tests. | Fidelity remains limited to implemented capabilities, not live-provider parity. | Pack maintainer: add conformance before widening claims. |
| Root CI workflow | GitHub Actions | Read-only repository token and SHA-pinned actions. | Workflow regression coverage is included in the final root suite; workflow definitions include lint/typecheck/test/build/package/audit, hosted, Docker, and Linux enforcement checks. | The workflows still must be observed on the exact final commit after push. | Maintainer: review and retain the GitHub run before publication. |
| Hosted pilot | Separate Bun/Elysia codebase, implemented but not deployed | Code-level tenant authorization, role checks, bounded request handling, hashed one-time secrets, durable quotas, idempotency, outbox/worker retries, dead-letter state, retention cleanup, readiness checks, and audit metadata. No live-service guarantee. | Clean hosted install; typecheck; 26 tests with zero skipped, including cloned auth-request body bounds; Bun build; zero-vulnerability audit; local non-root Docker image build; migrations `001`-`004` applied to PostgreSQL 17; concurrent organization quota race passed. | No staging deployment; live Google OAuth, Redis, QStash, sustained load, failover, and disaster-recovery behavior remain unproven. | Hosted owner: complete operational gates before any pilot use. |
| Product telemetry | Local runtime | Disabled by default, aggregate-only, no network transport; opt-out deletes local aggregate. | Product telemetry tests and package smoke. | Not a hosted/team analytics system. | Product owner: obtain explicit partner need before any networked design. |

## Threat Model Delta Since Session 06

- The old proxy-guidance-only model is now explicitly separated from Linux `ghostapi run` enforcement. Unsupported platforms fail closed instead of treating proxy configuration as isolation.
- Process execution now creates bounded lifecycle evidence, strips secret-shaped target environment values, limits target output, and records only aggregate output-secret/limit signals.
- Policy, scenario, contract, evidence, replay, and hosted report inputs have bounded parsers and reject traversal, symlink, archive, remote-reference, unsupported-schema, or secret-bearing inputs where applicable.
- Root CI now explicitly uses `contents: read`; the PR safety workflow remains SHA-pinned, artifact-bounded, and avoids executing fork code in its write-comment job.
- The hosted pilot now implements bounded request parsing, explicit tenant/role authorization, exact-origin mutation checks, one-time hashed invitation and ingest secrets, durable quotas, worker/outbox retry limits, dead-letter handling, retention cleanup, security headers, and dependency-aware readiness. These are locally tested implementation claims, not evidence of a deployed service.

## Open P2 Items

| Item | Plan | Owner |
| --- | --- | --- |
| GitHub Actions on the exact final commit is still required before publication. | Push the final commit, observe every required pinned workflow and job, and retain the run plus sanitized evidence links. | Maintainer. |
| Hosted staging and migration rehearsal are incomplete. | Deploy an isolated staging environment and apply the four application migrations plus the pinned Better Auth migration against production-shaped PostgreSQL; verify rollback/forward-recovery procedures and tenant authorization. | Hosted owner. |
| Hosted load and queue behavior are unproven. | Exercise production-shaped sustained/burst load, Redis rate limits, QStash signature validation/redelivery, outbox leases, worker retries/dead letters, and backlog drain behavior with measured thresholds. | Hosted owner. |
| Hosted disaster recovery is unproven. | Run repeated backup/restore and regional dependency-failure drills; record measured RPO/RTO instead of claiming the architectural targets. | Hosted owner. |
| Live OAuth and operational secret/configuration paths are unproven. | Validate Google OAuth redirect/origin configuration, session expiry/rotation, account-linking restrictions, secret rotation, and failure behavior in staging. | Hosted owner. |

## Release Gate

The root local package passed the final local 0.1.8 verification recorded in [the 0.1.8 verification record](development/verification-0.1.8.md). Publication still requires observing GitHub Actions on the exact final commit after push. Do not claim a deployed hosted service, completed hosted operational readiness, Linux enforcement on Windows/macOS, or billing availability from this matrix.
