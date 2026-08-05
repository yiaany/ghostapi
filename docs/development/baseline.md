# Development Baseline

Baseline captured on 2026-08-05 before product changes.

## Repository

- Working copy: `./repo`
- Remote: `https://github.com/yiaany/ghostapi.git`
- Branch: `main`
- Commit before baseline documentation: `f02d3e914c50ab6ade952aa38347b4e7ac4a35d8`
- Package: `@yiaany/ghostapi@0.1.7`
- License: MIT

## Environment

- Platform: Windows x64
- Git: `2.54.0.windows.1`
- Node.js: `26.4.0`
- npm: `11.17.0`
- pnpm: `11.12.0` (available but not used)
- Corepack: unavailable
- Required package manager: npm, selected from `package-lock.json` and the CI workflow
- Declared Node.js support: `>=20`
- CI environment: `ubuntu-latest`, Node.js 20

The local Node.js version satisfies the declared engine range but is newer than the version exercised by CI.

## Project Inventory

- Runtime: TypeScript, Node.js, Express, ESM
- Tests: Vitest with serial test-file execution
- Build: TypeScript compiler plus Vite landing-page build and static dashboard copy
- Providers: Stripe, Twilio, Resend, GitHub, Discord, OpenAI, and generic REST
- State: local files under `.ghostapi/`
- Interfaces: CLI, HTTP proxy/dashboard, and MCP stdio server
- CI: `.github/workflows/ci.yml` runs install, typecheck, tests, and build
- Release: manual checklist in `docs/release-checklist.md`; no automated publish workflow was found

## Verification Results

| Command | Result | Details |
| --- | --- | --- |
| `npm ci` | PASS | Installed 263 packages from the lockfile. npm reported 11 audit findings and two esbuild install scripts pending allow-scripts review. |
| `npm run typecheck` | PASS | Strict TypeScript check completed without diagnostics. |
| `npm test` | PASS | 21 test files and 102 tests passed. |
| `npm run build` | PASS | TypeScript, landing page, and dashboard static assets built successfully. |
| `node dist/cli/index.js --help` | PASS | Built CLI printed its command reference. |
| `node dist/cli/index.js providers list` | PASS | Printed seven registered providers. |
| `node dist/cli/index.js model get` | PASS | Printed `gpt-4o-mini`. |
| `npm pack --dry-run` | PASS | 188 files, 235.5 kB packed, 659.6 kB unpacked. No ignored local state or dependency directory was included. |
| Isolated packed-package install | PASS | Installed the generated tarball into a temporary project. The installed CLI, offline `/health`, and `/dashboard` smoke checks passed. |
| Formatter check | NOT RUN | No formatter script or repository formatter configuration exists. |
| Lint | NOT RUN | No lint script or repository lint configuration exists. |
| `npm audit` | FAIL | 11 findings: 7 moderate, 3 high, and 1 critical. |
| `npm audit --omit=dev` | FAIL | 5 runtime findings: 3 moderate and 2 high. |

The dependency tree was not updated during this baseline session. Audit remediation needs a controlled dependency session because one suggested full remediation upgrades Vite across a breaking major version.

## Findings

### P0

No confirmed secret disclosure, remote code execution, destructive production behavior, or live provider access by default was found during this baseline.

### P1

- Ambient `OPENAI_API_KEY` activates external LLM calls without a GhostAPI-specific opt-in. A local probe confirmed that `loadServerConfig` accepts the ambient key, and the configured path sends requests to the OpenAI API.
- Non-loopback bind is accepted without authentication. A local remote-bind probe confirmed an unauthenticated dashboard API mutation returned HTTP 200, and `/events` accepted a hostile browser origin with HTTP 200.
- Multiple tests recursively delete `.ghostapi/` relative to the repository working directory. Running the suite in a project with real GhostAPI state can erase user data.
- Persisted state and behavior updates use process-local locks and non-atomic whole-file writes. Multiple GhostAPI processes or a crash during a write can lose updates or leave corrupted JSON.
- Cache canonicalization sorts array elements. Requests whose array order is semantically meaningful can collide and receive an incorrect cached response.

### P2

- The root dependency tree has unresolved runtime and development advisories, including path traversal, host-confusion, SSRF-boundary bypass, ReDoS, and development-server findings. Exploitability in GhostAPI has not yet been established.
- `.ghostapi/events.jsonl` grows without a size or retention bound, and disk-write failures are silently ignored.
- CI tests only Linux on Node.js 20. The baseline was executed on Windows with Node.js 26.4.0, leaving other supported versions and operating systems uncovered.
- Formatting and linting are not automated.
- Generated tests hardcode `http://127.0.0.1:8080`, reducing portability in CI and parallel test environments.
- Package correctness depends on a prior build because no `prepack` verification prevents stale or missing `dist/` contents.

### P3

- `.env.example` describes `OPENAI_API_KEY` as future support even though the runtime currently consumes it.
- Release verification is documented but remains manual.

## Security Review Scope

The baseline inspected external network call sites, secret masking, request normalization, dashboard and SSE boundaries, local persistence, cache identity, tests that delete files, package contents, dependency advisories, and the release workflow.

The source tree contains one active external fetch target: the OpenAI chat-completions endpoint. Provider-shaped URLs in deterministic response bodies are data and are not outbound requests.

Deep fixes for authentication, LLM opt-in, data-directory isolation, retention, atomic persistence, cross-process locking, and dependency updates are intentionally deferred so the baseline remains a minimal documentation-only change.

## Reproduction

From `./repo`:

```bash
npm ci
npm run typecheck
npm test
npm run build
node dist/cli/index.js --help
node dist/cli/index.js providers list
node dist/cli/index.js model get
npm pack --dry-run
npm audit
npm audit --omit=dev
```

## Recommended Next Step

Run `sessions/02-security-and-reliability-baseline.md`. Prioritize explicit external-LLM opt-in, authentication for non-loopback control surfaces, isolated test data, bounded event persistence, atomic cross-process-safe state writes, and ordered cache-array semantics before expanding product surface area.
