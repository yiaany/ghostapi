# Changelog

All notable changes to GhostAPI will be documented in this file.

The format follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses semantic versioning once public releases begin.

## 0.1.6 - 2026-07-18

### Fixed

- Updated npm package repository, bugs, and homepage URLs to point to `yiaany/ghostapi` instead of broken legacy links.
- Replaced custom CI badge with live GitHub Actions workflow status badge (`yiaany/ghostapi/actions/workflows/ci.yml/badge.svg`).

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

- No real external provider API calls by default.
- Secrets are masked before prompt construction, cache key generation, event logging, and dashboard rendering.
- `ghostapi doctor` warns about unsafe TLS bypass settings.
