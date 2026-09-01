# Changelog

All notable changes to GhostAPI will be documented in this file.

The format follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses semantic versioning once public releases begin.

## Unreleased

## 0.2.0 - 2026-09-01

### Security

- Corrected evidence semantics so unmeasured production-egress attempt counts are reported as `not measured` instead of a fabricated zero.
- Reframed the bounded repository safety scan as a provider-risk heuristic scan and exposed its file, size, and extension limits.
- Removed external font requests from the local dashboard and added a regression test for external dashboard asset URLs.
- Added CodeQL, OSV, OpenSSF Scorecard, Dependabot, container scanning, coverage thresholds, and retained Linux egress test output.
- Added locked compatibility tests for the official Stripe `22.6.0` and OpenAI `7.8.0` Node SDKs against a loopback-only GhostAPI server.

### Changed

- Repositioned GhostAPI as an AI-assisted local API simulation experiment with explicit non-goals and no customer-validation claims.
- Added project provenance, contribution authorship guidance, full-tree formatting, and type-aware ESLint parsing.
- Corrected 36 pre-0.2 Git author and committer identities from an accidental local tool identity to the contributing maintainer while preserving file trees, messages, and dates.
- Removed fundraising, commercial, design-partner, community-operations, and enterprise-roadmap material from the public tree and npm package.
- Added a release workflow for signed annotated tags, exact-tarball smoke testing, checksums, SBOM generation, build attestations, npm provenance, and post-publish `gitHead` verification.
- Centered the README hero and dashboard product identity, and added responsive navigation and request/detail layouts for mobile screens.

## 0.1.8 - 2026-08-22

### Security

- Added a local tenant-scoped action ledger with bounded structured redaction, SHA-256 append-only chains, verification/export integrity checks, legal-hold/deletion-request semantics, and no credential or raw payload persistence. Added incident-to-synthetic-world/scenario fixtures that replay only in memory and preserve ambiguous outcomes as reconciliation-required.
- Added a local tenant-scoped agent inventory and attack-path graph (`inventory.json`) with provenance- and freshness-carrying records and edges, tenant-scoped reads/writes/export, strict payload validation that rejects secret-shaped values, reference-bound operator authorization per action, bounded store, an open export (inventory, policies, eval scenario references, evidence metadata, removal analysis, ROI built only from imported counters and applied remediations), and a remediation workflow whose scope reductions are validated as strict subsets at proposal and apply time. Heuristic blast-radius classifications are explicitly labeled advisory. The enterprise pilot gate is not yet met; results are for local synthetic review.
- Added a persisted local synthetic safety controller with scoped kill switches, locked budget reservations, circuit breakers, bounded queue/dead-letter handling, audited separately authorized re-enable, final synthetic commit checks, and a scheduled non-destructive game-day drill. No provider, credential, HTTP, or hosted emergency transport was added.
- Added a local synthetic trust ladder with strict no-side-effect level capabilities, explicit unsupported dry-run/trusted states, verified-owner promotion evidence, deterministic scoped canaries, hash-only shadow/outcome comparison, automatic demotion/circuit-breaker policy, rollback audit reasons, and no provider execution path.
- Hardened the local approval inbox so inbox-issued artifacts cannot be submitted or executed through the public action-gateway path, and verified approver principals prevent actor aliases from self-approving or satisfying two-person review.
- Hardened credential execution receipts and revocation handling: vault/provider I/O no longer holds the broker mutation lock, executors must recheck active grants before side effects, and executor errors are recorded as non-retryable unknown outcomes rather than confirmed failures.
- Added a local approval inbox with action-hash-bound, one-time expiring artifacts, derived risk taxonomy, independent two-person approval, amount/resource/environment/actor/confidence/velocity policy checks, timeout/revoke fail-closed handling, and action-receipt-linked audit records for the synthetic adapter only.
- Added a credential-broker and workload-identity boundary that stores only metadata, issues scoped server-only short-lived grants bound to action receipts, rechecks revocation/expiry/scope/tenant/workload at execution, invalidates grants on rotation, and ships test-only vault/provider adapters without real credential or network capability.
- Bound explicit evidence run-input files before parsing and reject malformed JSON, preventing unbounded local memory consumption through `evidence generate --run`.
- Redact secret-shaped target-start errors before writing Linux run evidence.
- Redact secret-shaped target stdout/stderr before forwarding it to the operator or CI log, including tokens split across stream chunks; interrupted namespace runs now preserve the caller signal exit code and finalize evidence after escalation.
- Added bounded queue-body handling to the separate undeployed hosted pilot before signature verification or JSON parsing.
- Hardened the undeployed hosted pilot with explicit tenant/role authorization, tenant-safe cross-boundary responses, exact-origin mutation checks, secure session/cookie and response-header defaults, and one-time SHA-256-only invitation and ingest secrets.
- Added hosted request/body limits, concurrency-safe durable quotas, bounded worker/outbox retries and dead-letter state, retention cleanup, and dependency-aware readiness checks; these controls are implemented and locally verified but not yet deployed.
- Restricted the standard GitHub Actions CI token to `contents: read`.

### Changed

- Published a valid package root with ESM and declaration exports, and extended packed-artifact smoke coverage to import `@yiaany/ghostapi` directly.
- Corrected repository identity to `yiaany/ghostapi`, standardized public commands on `@yiaany/ghostapi`, removed the bundled landing page so `/` opens the dashboard, and clarified setup generation and scenario arming behavior.
- Upgraded Vite and Vitest to audited compatible versions, added formatting checks, and expanded CI across Node.js and desktop platforms with package, production audit, and hosted-pilot checks.
- Clarified that `GET /health` is a liveness response that stays HTTP 200 while `GET /health/readiness` returns the structural report and HTTP 503 when dependencies are degraded.
- Added deterministic malformed-input regression coverage for policy, OpenAPI, and scenario-bundle parsers.
- Added release-readiness and migration/rollback documentation with platform-specific guarantees and known gaps.

### Fixed

- Fixed dashboard clear actions so non-2xx responses are reported as failures, filtered request counts reflect visible rows, and malformed SSE messages are ignored without breaking the stream handler.
- Hardened the safety controller and action gateway: time-bounded synthetic leases with a default 60 s TTL, a two-phase final commit that re-checks the lease and records `action.final_check` after the operation, a tolerant terminal `complete()`, a stable `SAFETY_KILL_SWITCH` error code, and bounded dead-letter eviction. Gateway commit errors are no longer silently swallowed.
- Hardened the action ledger: caller-claimed basis markers on echoed policy/approval records, per-tenant retention rotation with hash-chain relinking at the 2,000-entry bound, and a `tracked` flag so a tenant without entries verifies distinctly from a broken chain.
- Hardened local reliability: SLO sampling is batch-bounded and latency counts only successful samples, reconciliation rejects missing worlds structurally and requires the `reconciliation.manage` permission, and cost governance is idempotent with a pure report path and tenant-scoped alerts.
- Hardened runtime health and backups: the inventory store is part of health checks, restores refuse non-empty directories, and backup exclusions use canonical cache/backup paths instead of folder names.
- Hardened the inventory controller: stale attack-path edges are filtered and garbage-collected, findings and import runs are bounded with per-tenant rotation, ineffective remediations can be reopened and are gated by injected eval-scenario existence, and remediation targets validate the environment reference.

## 0.1.7 - 2026-07-18

### Changed

- Set npm package `homepage` link to the landing repository `yiaany/ghostweb` so npm cards point to the public site instead of repository code.

## 0.1.6 - 2026-07-18

### Fixed

- Updated npm package repository, bugs, and homepage URLs to point to the then-current repository instead of broken legacy links.
- Replaced the custom CI badge with a live GitHub Actions workflow status badge.

## 0.1.5 - 2026-07-18

### Fixed

- Replaced Stripe-looking fake secret examples with `stripe_test_ghostapi` so npm's README secret scanner does not render examples as `***`.
- Kept the 30 second curl command fully copy-pasteable with closed quotes and explicit fake credentials.
- Updated generated setup snippets and agent rules to use the same non-redacted fake Stripe key.

## 0.1.4 - 2026-07-18

### Fixed

- Revalidated npm README copy-paste snippets for the 30 second curl flow and OpenAI SDK setup.
- Updated generated Stripe setup snippets to use local `host`, `port`, and `protocol` options instead of the old `apiBase` example.
- Kept example keys explicit as fake local credentials so public docs do not look redacted or broken.

## 0.1.3 - 2026-07-18

### Fixed

- Corrected npm installation commands to use the published package name `@yiaany/ghostapi`.
- Replaced unscoped package examples with `npx @yiaany/ghostapi` so copy-paste install works from npm.
- Updated Stripe SDK examples to point at local GhostAPI host, port, and protocol options.

### Changed

- Shortened the npm README around install, a 30 second local win, MCP setup, and SDK examples.
- Updated npm package description and keywords for MCP, Stripe, OpenAI, Cursor, proxy, and sandbox discoverability.
- Moved React dashboard build dependencies out of runtime dependencies.

## 0.1.0 - 2026-07-14

### Added

- Local Express proxy server on `127.0.0.1:8080` by default.
- CLI commands for `start`, `clear`, `model`, `providers`, `doctor`, and `init`.
- Native MVP provider adapters for Stripe, Twilio, Resend, GitHub, and Discord.
- Generic fallback coverage for other REST APIs with lightweight service inference.
- Request normalization and secret masking for headers, query, and JSON bodies.
- File-per-entry response cache under `.ghostapi/cache/{provider}/{hash}.json`.
- Local state store under `.ghostapi/state.json` with save/read/list/delete behavior.
- Provider-specific validation and error formatting for key MVP flows.
- LLM-backed JSON mock generation with offline fallback.
- Realtime dashboard at `/dashboard` with SSE events from `/events`.
- Persistent telemetry history at `.ghostapi/events.jsonl`.
- Examples for Stripe, Resend, Twilio, GitHub, generic REST, and AI agent instructions.
- Open-source project docs, security policy, issue templates, and PR template.

### Security

- Added a local reliability layer with bounded stores and reference-bound capabilities: a local SLO controller (`slo.json`) that records samples only with a verified record capability, restricts configure/evaluate to authenticated operators, trims evaluation windows, and caps samples per metric and store bytes; a local reconciliation service (`reconciliation.json`) that blocks on ledger integrity failure, classifies ledger timelines as committed/not-committed/unknown/compensated/drifted against synthetic provider state, opens resolveable findings, and records duplicate-prevention, receipt-verification, availability, and execution-latency SLI samples; a local cost-governance store (`costs.json`) with capped attribution records, budgets, acknowledgeable alerts, and a linear-extrapolation forecast explicitly labeled as not a provider invoice; and runtime health plus verified local backup/restore (`reliability/backups/`) with sha256 manifests, tamper and path-traversal rejection, and no egress. `GET /health` reports liveness with readiness state at HTTP 200, while `GET /health/readiness` returns the structural report and HTTP 503 when a store is degraded.

- No real external provider API calls by default.
- Secrets are masked before prompt construction, cache key generation, event logging, and dashboard rendering.
- `ghostapi doctor` warns about unsafe TLS bypass settings.
