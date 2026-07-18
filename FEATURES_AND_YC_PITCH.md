# GhostAPI: Features, Technical Scope, And YC Pitch

## One-Liner

GhostAPI is a local internet and third-party API simulator for AI coding agents and developers, letting apps test Stripe, Twilio, Resend, GitHub, Discord, OpenAI, and generic REST APIs without real credentials, real money movement, external calls, or brittle hand-written mocks.

## Product Summary

Modern apps depend on many external APIs. AI coding agents increasingly write code that touches those APIs, but they cannot safely call production services, use real secrets, create real charges, send real messages, or rely on live internet behavior during development.

GhostAPI runs locally as a zero-config HTTP proxy. Developers point SDKs or HTTP clients at `http://127.0.0.1:8080`, and GhostAPI returns realistic provider-shaped responses, persists local state, logs traffic in a dashboard, simulates failures, and exposes an MCP server so AI agents can inspect and control mock behavior directly.

## Core Features

### Local API Proxy

- Runs an Express server locally, defaulting to `127.0.0.1:8080`.
- Handles common HTTP methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`.
- Keeps internal routes like `/health`, `/dashboard`, `/events`, and `/api/*` separate from proxied traffic.
- Designed to avoid real third-party provider calls by default.
- Supports offline mode for deterministic local fallback behavior.

### Provider Detection

GhostAPI detects the target provider from request path, headers, query, and body.

Supported native providers:

- Stripe
- Twilio
- Resend
- GitHub
- Discord
- OpenAI
- Generic REST

The generic detector also labels common REST shapes, for example Shopify-like or task-like APIs, so dashboard traffic is easier to understand.

### Provider-Shaped Responses

- Returns JSON that resembles the target provider's API conventions.
- Uses provider adapters to format errors correctly.
- Supports stateful object creation and lookup flows.
- Falls back to generated local mock data when a request does not match a known state or cache entry.

### Provider-Shaped Errors

GhostAPI validates selected requests and returns provider-style errors.

Examples:

- Stripe missing `amount` or `currency` returns a Stripe-style `invalid_request_error`.
- Twilio missing `To`, `From`, or message body returns Twilio-style validation errors.
- Resend missing email fields returns validation-shaped errors.
- Chaos Mode errors are also formatted through the provider adapters.

### Secret Masking

- Sanitizes headers, query parameters, and request bodies before logging, caching, prompting, or dashboard rendering.
- Masks common secret field names like `api_key`, `token`, `secret`, `password`, and authorization headers.
- Masks known token patterns such as Stripe, GitHub, Slack, SendGrid, and bearer tokens.
- Prevents accidental leakage of real credentials to the dashboard, cache, event logs, or AI generation layer.

### Cache Layer

- Stores mock responses under `.ghostapi/cache/{provider}/{hash}.json`.
- Uses stable cache keys built from method, path, normalized query, sanitized body, and important headers.
- Repeated equivalent requests produce cache hits.
- Dashboard events mark cache hits and misses.

### Local State Store

- Persists generated objects in `.ghostapi/state.json`.
- Supports stateful create/read/list/delete style behavior.
- Uses mutex-protected writes to avoid corrupting local state.
- Saves generated objects from `POST`, `PUT`, and `PATCH` responses when an ID can be extracted.
- Returns later matching reads from state before cache or AI generation.

### Event Log

- Captures recent proxy events in memory.
- Persists event history to `.ghostapi/events.jsonl`.
- Tracks method, path, provider, status code, duration, source, sanitized request, and response.
- Event sources include:
  - `state`
  - `cache`
  - `ai`
  - `error`
  - `fallback`
  - `stream`
  - `fault`
  - `behavior`

### Live Dashboard

- Available at `http://localhost:8080/dashboard`.
- Built with plain HTML, CSS, and JavaScript, with no React or bundler.
- Uses a dark Linear/Vercel-style layout.
- Includes a sidebar, provider filters, search modal, live traffic list, and request/response details pane.
- Streams events in real time through Server-Sent Events at `/events`.
- Fetches history through `/api/events`.
- Includes controls for clearing cache and state.
- Includes Chaos Mode toggle.
- Includes Generate AI Rules modal.

### Chaos Mode

Chaos Mode is a realistic local failure injector for testing retry logic and agent-generated resilience code.

When enabled:

- 85% of requests pass through normally.
- 15% of requests are affected by chaos.
- Chaos randomly chooses one of:
  - `429 Too Many Requests`
  - `503 Service Unavailable`
  - artificial latency between 2 and 5 seconds
- Error bodies are formatted for the detected provider.
- `retry-after` is included for error responses.
- Dashboard events record chaos outcomes as `fault` events.

This is useful for testing:

- retry logic
- exponential backoff
- timeout handling
- queue workers
- payment failure paths
- degraded third-party dependencies
- AI agent behavior under non-happy-path API conditions

### MCP Server

GhostAPI includes an MCP server for AI agents.

Command:

```bash
ghostapi mcp
```

Transport:

- Official Model Context Protocol SDK
- `StdioServerTransport`

Available MCP tools:

| Tool | Purpose |
| --- | --- |
| `inspect_state` | Reads local `.ghostapi/state.json`. |
| `set_api_behavior` | Configures deterministic responses for `method + path`. |
| `get_traffic_logs` | Returns the latest 50 captured events. |
| `toggle_chaos_mode` | Enables or disables Chaos Mode behavior. |

### File-Backed API Behavior Overrides

- MCP can write deterministic behavior to `.ghostapi/behaviors.json`.
- The running proxy process reads this file on each request.
- This allows the MCP process and HTTP proxy process to be separate but coordinated.
- Overrides return `x-ghostapi-behavior: HIT`.
- Overrides are useful for AI agents that need to force a specific response, such as a `429`, `500`, or specific JSON body.

### Generate AI Rules

Dashboard includes a `Generate AI Rules` action.

Backend endpoint:

```http
POST /api/ai-rules
```

Behavior:

- Reads `package.json` from the current working directory.
- Scans dependencies, dev dependencies, peer dependencies, and optional dependencies.
- Detects provider SDKs such as `stripe`, `twilio`, `resend`, and `openai`.
- Generates ready-to-copy `.cursorrules` content.
- If `stripe` is detected, it generates host override instructions for `127.0.0.1:8080`.

Example Stripe rule:

```ts
import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "stripe_test_ghostapi", {
  host: process.env.GHOSTAPI_HOST ?? "127.0.0.1",
  port: Number(process.env.GHOSTAPI_PORT ?? "8080"),
  protocol: process.env.GHOSTAPI_PROTOCOL ?? "http"
});
```

### One-Click Repo Setup

GhostAPI now has a first-class onboarding generator for the current repository.

CLI:

```bash
ghostapi setup
```

Dashboard action:

```text
Agent Setup
```

Backend endpoint:

```http
POST /api/setup
```

The setup generator scans `package.json`, detects provider SDKs, returns startup commands, returns `.cursorrules`, returns Cursor/Cline/Claude MCP configs, and returns SDK-specific code patches.

This turns GhostAPI from “a tool you configure” into “a tool you activate for this repo.”

### Scenario Presets And Replay

GhostAPI includes agent-ready scenario presets.

Backend endpoints:

```http
GET /api/scenarios
POST /api/scenarios/:id/replay
GET /api/scenarios/:id/export
POST /api/scenarios/:id/share
```

Built-in scenarios:

- Stripe customer create
- Stripe payment intent fail
- Resend email send
- GitHub issue create

Scenario actions:

- `Replay` applies deterministic behavior overrides through `.ghostapi/behaviors.json`.
- `Export` returns portable JSON for a scenario.
- `Share` returns a compact `ghostapi://scenario/...` payload.

This moves GhostAPI beyond plain mocking: agents can replay product-level API flows, test failure paths, and share known-good integration scenarios.

### CLI

Current CLI commands include:

```bash
ghostapi start
ghostapi start --port 8080 --host 127.0.0.1
ghostapi start --offline
ghostapi start --https
ghostapi clear cache
ghostapi clear state
ghostapi clear events
ghostapi clear all
ghostapi model get
ghostapi model set <model>
ghostapi providers list
ghostapi providers inspect <provider>
ghostapi doctor
ghostapi init
ghostapi setup
ghostapi mcp
```

### Local Config

- `ghostapi init` creates local project config under `.ghostapi/config.json`.
- Supports model configuration and local server options.
- `ghostapi doctor` checks environment health.

### NPM Packaging

- Package exposes the `ghostapi` binary.
- Build output is included through `dist`.
- Dashboard static files are copied into `dist/dashboard` during build.
- Package files include docs, examples, README, changelog, security policy, contributing guide, and license.
- Runtime files like `.ghostapi`, `.env`, logs, tests, and `node_modules` are excluded from the package.

## Technical Architecture

### Runtime

- Node.js `>=20`
- TypeScript
- ESM modules
- Express HTTP server
- Plain browser JavaScript dashboard
- Vitest test suite

### Main Modules

| Area | Files |
| --- | --- |
| CLI | `src/cli/index.ts`, `src/cli/parser.ts` |
| Server | `src/server/createServer.ts`, `src/server/routes.ts`, `src/server/eventsStore.ts`, `src/server/sse.ts` |
| Proxy | `src/proxy/proxyHandler.ts`, `src/proxy/requestNormalizer.ts`, `src/proxy/providerDetector.ts`, `src/proxy/cacheKey.ts` |
| Providers | `src/providers/*` |
| Errors | `src/errors/*` |
| Cache | `src/cache/index.ts` |
| State | `src/state/*` |
| Security | `src/security/*` |
| Dashboard | `src/dashboard/index.html`, `src/dashboard/styles.css`, `src/dashboard/app.js` |
| Fault Injection | `src/fault/faultLab.ts` |
| MCP | `src/mcp/server.ts` |
| Behavior Overrides | `src/behavior/behaviorStore.ts` |
| AI Rules | `src/rules/aiRules.ts` |
| Setup Generator | `src/setup/sdkDetector.ts`, `src/setup/setupGenerator.ts` |
| Scenarios | `src/scenarios/scenarioStore.ts` |

### Proxy Request Lifecycle

1. Express receives a request.
2. Provider is detected from request shape.
3. Request is normalized and secrets are masked.
4. File-backed behavior override is checked.
5. Chaos Mode may inject a provider-shaped error or delay.
6. Provider validation runs.
7. State store is checked.
8. Cache is checked.
9. AI/local fallback mock generation runs.
10. Response is cached when appropriate.
11. State is updated when a generated object ID is detected.
12. Event is recorded and streamed to the dashboard.

### Data Written Locally

| File | Purpose |
| --- | --- |
| `.ghostapi/config.json` | Project-local GhostAPI config. |
| `.ghostapi/state.json` | Local API object state. |
| `.ghostapi/events.jsonl` | Persisted event log. |
| `.ghostapi/behaviors.json` | Agent-configured deterministic mock behavior. |
| `.ghostapi/cache/*` | Cached provider responses. |

### Safety Model

- Local-first by default.
- No real provider calls by default.
- Secret masking before logging, caching, dashboard display, or AI prompt construction.
- Dashboard only shows sanitized traffic.
- MCP uses stdio and must not write protocol-breaking logs to stdout.
- Chaos Mode is opt-in.

## Current Verification Status

The project currently verifies with:

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Latest verification:

- TypeScript typecheck passed.
- Test suite passed: 20 test files, 93 tests.
- Build passed.
- NPM pack dry-run passed.

Known issue:

- `npm audit` still reports dependency findings in the installed tree. These should be reviewed before a public release.

## YC Pitch Deck

### Slide 1: Company

**GhostAPI**

Local internet simulation for AI coding agents.

We let developers and agents build against Stripe, Twilio, OpenAI, GitHub, and other APIs without real credentials, real charges, real messages, or flaky live services.

### Slide 2: Problem

Software now depends on dozens of external APIs.

AI coding agents are writing more of that integration code, but they are unsafe and unreliable around external services.

Pain points:

- Developers do not want agents using real API keys.
- Tests should not create real charges, emails, SMS messages, or cloud resources.
- Live third-party APIs are slow, flaky, rate-limited, and expensive.
- Mocking each provider by hand is repetitive and often unrealistic.
- AI agents need tool-accessible state, logs, and controllable failure modes.

### Slide 3: Why Now

AI coding agents are changing development workflows.

Before, developers manually wrote mocks and tests.

Now, agents generate code, run tests, inspect errors, and iterate autonomously. But agents need a safe local internet to operate inside.

The missing layer is an API simulator that is local, realistic, observable, and controllable by agents.

### Slide 4: Solution

GhostAPI is a local proxy that simulates third-party APIs.

Developers run:

```bash
ghostapi start
```

Then point SDKs and HTTP clients at:

```text
http://127.0.0.1:8080
```

GhostAPI handles provider-shaped responses, local state, caching, traffic logs, chaos testing, and MCP control for AI agents.

### Slide 5: Product

GhostAPI includes:

- Local Express proxy
- Provider detection
- Stripe/Twilio/Resend/GitHub/Discord/OpenAI adapters
- State and cache
- Live dashboard
- Secret masking
- Chaos Mode
- MCP server
- Agent-configurable behavior overrides
- Automatic `.cursorrules` generation

### Slide 6: User Workflow

1. Developer installs GhostAPI.
2. Developer starts local proxy.
3. Dashboard opens at `/dashboard`.
4. App or AI agent sends API traffic to `localhost:8080`.
5. GhostAPI returns realistic provider-shaped responses.
6. Agent uses MCP to inspect state, read logs, force specific responses, or enable Chaos Mode.
7. Developer ships integration code without touching production APIs.

### Slide 7: Initial Users

Target users:

- AI coding agent power users
- Startups building API-heavy products
- Teams with Stripe/Twilio/OpenAI integrations
- QA and platform teams
- Developer tool companies
- CI environments where external API calls are forbidden

Initial wedge:

- Developers using Cursor, Cline, Claude Code, Codex, OpenCode, and similar tools.

### Slide 8: Market

GhostAPI sits at the intersection of:

- API mocking
- developer testing infrastructure
- AI coding agents
- local-first development tools
- CI reliability

Existing categories include Postman, WireMock, Mockoon, Stripe CLI fixtures, MSW, and provider-specific sandboxes.

GhostAPI's wedge is agent-native local API simulation.

### Slide 9: Differentiation

GhostAPI is different because it is:

- Local-first
- Agent-native through MCP
- Provider-shaped out of the box
- Safe by default with secret masking
- Stateful without configuration
- Observable through a live dashboard
- Failure-aware through Chaos Mode
- Useful without writing mock definitions first

Traditional mocks require humans to predefine behavior. GhostAPI lets agents inspect, configure, and evolve behavior during development.

### Slide 10: Competitive Landscape

| Product Type | Limitation | GhostAPI Advantage |
| --- | --- | --- |
| Provider sandboxes | Still external, limited failure control | Local, fast, controllable |
| Mock servers | Require manual mock definitions | Zero-config provider detection |
| HTTP record/replay | Needs real traffic first | Generates realistic local responses |
| API clients | Mainly manual testing | Built for runtime app integration |
| MSW-style mocks | App-level and hand-written | Proxy-level and agent-controllable |

### Slide 11: Business Model

Open-source core:

- Local proxy
- Dashboard
- Provider adapters
- Basic MCP tools

Potential paid products:

- Team dashboard
- Shared mock workspaces
- CI cloud replay
- Provider packs
- Enterprise security controls
- Audit logs
- SOC2-friendly policy enforcement
- Hosted team state and contract sync
- Agent test reports

### Slide 12: Go-To-Market

Initial distribution:

- Open source launch
- Cursor/Cline/Claude Code/OpenCode communities
- Developer Twitter/X and Hacker News
- Templates for Stripe, Twilio, OpenAI, and SaaS starter kits
- GitHub examples and agent rules
- Content around “safe API testing for AI agents”

Expansion:

- CI integrations
- Team workspaces
- Provider-specific packs
- Enterprise dev platform integrations

### Slide 13: Metrics To Track

Early metrics:

- GitHub stars
- npm installs
- weekly active local servers
- dashboard sessions
- MCP tool calls
- provider usage breakdown
- generated `.cursorrules` count
- successful CI runs using GhostAPI

Paid metrics later:

- team workspaces created
- seats per workspace
- CI minutes or runs
- retained weekly active teams

### Slide 14: Roadmap

Near-term:

- Harden npm release
- Improve provider coverage
- Add more SDK-specific agent rules
- Add persisted Chaos Mode config
- Add dashboard controls for exact chaos profiles
- Add MCP resources for docs and provider contracts

Medium-term:

- Record/replay mode
- OpenAPI import/export
- Test scenario builder
- CI mode
- Team-shared mock state
- Provider marketplace

Long-term:

- Standard local internet layer for autonomous software agents.

### Slide 15: Vision

AI agents need a safe world to develop in.

GhostAPI becomes the local internet for software development: realistic enough to build against, safe enough for agents, and controllable enough for tests.

The end state is that every AI coding agent has GhostAPI running next to it by default.
