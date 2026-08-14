# Release Readiness Matrix

Last reviewed: 2026-08-09.

This matrix is a release-candidate review, not a publication approval. No Git tag, GitHub release, or npm publication was created during this review.

| Feature | Platform / boundary | Guarantee level | Evidence reviewed | Known gap | Owner before release |
| --- | --- | --- | --- | --- | --- |
| Local provider simulation, dashboard, MCP | Node.js 26.4.0 on Windows; Node.js 20.20.2 Ubuntu WSL 2 | Local simulation only; no real provider calls by default. | Root typecheck, full root suite, build, package smoke, built-CLI smoke on Windows and Linux. | Windows is not enforcement evidence. | Maintainer: retain CI results for a release commit. |
| `ghostapi run` | Linux only when `unshare` and `ip` preflight pass | Loopback-only user/mount/network/PID namespace; fail closed. Not a hostile-code filesystem sandbox. | Node.js 20.20.2 Ubuntu WSL 2 Linux filesystem: full namespace suite, loopback, direct-IP/subprocess/curl bypass blocking, interruption, timeout/process-tree cleanup, output limits, terminal redaction, `ghostapi run -- npm test`, and safe-evidence/blocked-egress CI smoke. | Local WSL evidence is not a substitute for CI on the exact release commit. | Maintainer: run the workflow on a supported GitHub Linux runner and retain sanitized evidence. |
| Policy parser | Local YAML input | Bounded, one-document, no anchors/aliases/interpolation, path-contained parsing. | Unit tests plus 400 deterministic malformed-input cases. | Fuzz corpus is deterministic regression coverage, not a replacement for long-running fuzzing. | Maintainer: extend corpus when syntax support changes. |
| Evidence reports | Local files and explicit `--run` input | Bounded report/run input, secret redaction, canonical logical hash, fail-closed CI result. | Evidence tests include corruption, traversal, terminal escapes, malformed and oversized run evidence. | Same-user filesystem TOCTOU remains outside the local lock/store threat boundary. | Maintainer: document/assess before any shared filesystem support. |
| Record/replay and contract import | Local JSON/HAR/OpenAPI input | Bounded JSON only; archives, remote refs, symlinks, unsafe hosts, redirects, and secret-bearing bundles reject. | Scenario and contract suites; deterministic malformed-input coverage. | Sanitization is heuristic and requires operator review before sharing. | Maintainer: maintain provider/sanitizer regression fixtures. |
| Provider packs | Local runtime | Deterministic provider-shaped behavior; unsupported endpoints fail diagnostically. | Stripe lifecycle/conformance tests and provider tests. | Fidelity remains limited to implemented capabilities, not live-provider parity. | Pack maintainer: add conformance before widening claims. |
| Root CI workflow | GitHub Actions | Read-only repository token and SHA-pinned actions. | Workflow regression tests review pins, permission boundary, enforced run, evidence artifact, and fork-safe comment rule. | Workflow execution was not performed in this local session. | Maintainer: review GitHub run before release. |
| Hosted pilot skeleton | Separate Bun/Elysia codebase, not published | Undeployed architecture only. CI ingest key hashes, tenant checks, queue signature verification, idempotency, and bounded queue body helper are code/tested boundaries. | 7 hosted Node test cases; hosted typecheck; production dependency audit. | Bun, database migrations, auth provider, QStash, Fly, load, DR, and live authorization flows were not run. | Hosted owner: staging deployment and drills before pilot use. |
| Product telemetry | Local runtime | Disabled by default, aggregate-only, no network transport; opt-out deletes local aggregate. | Product telemetry tests and package smoke. | Not a hosted/team analytics system. | Product owner: obtain explicit partner need before any networked design. |

## Threat Model Delta Since Session 06

- The old proxy-guidance-only model is now explicitly separated from Linux `ghostapi run` enforcement. Unsupported platforms fail closed instead of treating proxy configuration as isolation.
- Process execution now creates bounded lifecycle evidence, strips secret-shaped target environment values, limits target output, and records only aggregate output-secret/limit signals.
- Policy, scenario, contract, evidence, replay, and hosted report inputs have bounded parsers and reject traversal, symlink, archive, remote-reference, unsupported-schema, or secret-bearing inputs where applicable.
- Root CI now explicitly uses `contents: read`; the PR safety workflow remains SHA-pinned, artifact-bounded, and avoids executing fork code in its write-comment job.
- The hosted skeleton now bounds a queue body before JSON parsing or signature verification. It remains an undeployed architecture, not a security claim for a live service.

## Open P2 Items

| Item | Plan | Owner |
| --- | --- | --- |
| Full `npm audit` reports 5 dev-only Vite/Vitest/esbuild findings. | Plan and test a breaking Vite 8/Vitest 4 upgrade in a dedicated maintenance change. Do not use `npm audit fix --force` blindly. | Maintainer. |
| Linux CI run on the exact release commit is still required before publication. | Run pinned CI with namespace preflight, safe fixture, blocked-egress fixture, evidence generation, and package smoke. | Maintainer. |
| Hosted pilot operational controls are unproven. | Provision staging, run Better Auth/app migrations, authorization/redelivery/load/DR drills, then review production readiness separately. | Hosted owner. |
| No formatter or lint script is configured. | Select tooling in a separate low-churn change; do not make a release claim that formatter/lint passed. | Maintainer. |

## Release Gate

The root local package is suitable for a reviewed release candidate only after the verification commands in [release and rollback](release-migration-and-rollback.md) pass on the proposed release commit. Do not claim a hosted-service release, Linux enforcement guarantee on Windows/macOS, or billing availability from this matrix.
