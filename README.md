<p align="center">
  <img src="docs/assets/ghostapi-avatar.png" alt="GhostAPI" width="104" height="104">
</p>

<h1 align="center">GhostAPI</h1>

<p align="center">
  <strong>The local internet for AI coding agents.</strong>
</p>

<p align="center">
  Build and test third-party API integrations locally, without charging cards, sending messages, leaking production keys, or mutating real services.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@yiaany/ghostapi"><img alt="npm" src="https://img.shields.io/npm/v/@yiaany/ghostapi?color=0f172a&label=npm"></a>
  <a href="https://github.com/yiaany/ghostapi/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-0f172a"></a>
  <a href="https://github.com/yiaany/ghostapi/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/yiaany/ghostapi/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-0f172a">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-enabled-0f172a">
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#what-you-get">Features</a> ·
  <a href="#provider-support">Providers</a> ·
  <a href="#mcp-for-agents">MCP</a> ·
  <a href="#safety-boundaries">Safety</a> ·
  <a href="#hosted-and-enterprise">Enterprise</a>
</p>

```bash
npx @yiaany/ghostapi start --open
```

<p align="center">
  <img src="docs/assets/dashboard.png" alt="GhostAPI dashboard with live local Stripe, OpenAI, and REST traffic">
</p>

## Why GhostAPI

Coding agents can write a Stripe checkout, an OpenAI workflow, a GitHub automation, or an email integration in minutes. The dangerous part is what happens when they run that code.

Without a safe local target, a test can:

- charge a real card;
- send a real email or SMS;
- create or modify real GitHub resources;
- spend API credits;
- leak credentials into logs, prompts, screenshots, or test fixtures.

GhostAPI gives your application and coding agent a local API world at `127.0.0.1:8080`. Requests are detected, sanitized, recorded, and answered with deterministic provider-shaped responses. You can inspect the result in the dashboard, control behavior through MCP, and turn failures into repeatable tests.

## Quickstart

Start the local server and dashboard:

```bash
npx @yiaany/ghostapi start --open
```

Send a Stripe-shaped request:

```bash
curl -X POST http://127.0.0.1:8080/v1/customers \
  -H "content-type: application/json" \
  -H "authorization: Bearer stripe_test_ghostapi" \
  -d '{"email":"ada@example.com","name":"Ada Lovelace"}'
```

Open the dashboard at `http://127.0.0.1:8080/dashboard`. The request appears in live traffic with its provider, request body, generated response, source, status, and timing.

Initialize GhostAPI inside an existing repository:

```bash
npx @yiaany/ghostapi init
npx @yiaany/ghostapi doctor
```

`init` creates local configuration, a versioned safety policy, MCP snippets, and agent instructions without overwriting existing files.

On a supported Linux host, run a command inside the loopback-only network namespace:

```bash
npx @yiaany/ghostapi run -- npm test
```

On Windows and macOS, `ghostapi run` fails closed because an equivalent process-isolation backend is not implemented. The local API server and dashboard still work normally.

## What You Get

| Feature | What it does |
| --- | --- |
| Local API sandbox | Gives SDKs and applications a local target instead of a live provider. |
| Provider-shaped behavior | Returns realistic objects, validation errors, rate limits, declines, and failure payloads. |
| Live dashboard | Shows requests and responses, filters traffic by provider, generates tests, and arms scenarios. |
| MCP control plane | Lets compatible coding agents inspect state, read traffic, configure responses, and toggle Chaos Mode. |
| Stateful synthetic worlds | Maintains deterministic local identities and state across Stripe, GitHub, email, and REST projections. |
| Scenarios and record/replay | Saves sanitized sandbox traffic and replays it offline as deterministic fixtures. |
| Contract drift checks | Imports bounded OpenAPI/HAR contracts and classifies breaking, non-breaking, and uncertain changes. |
| Agent evals and evidence | Produces redacted, tamper-evident reports for local review and CI policy gates. |
| Secret protection | Masks secret-shaped headers, query parameters, bodies, paths, events, prompts, and cache inputs. |
| Fault testing | Forces latency, provider errors, card declines, rate limits, and other unhappy paths. |
| Safety controls | Includes local approvals, scoped budgets, kill switches, circuit breakers, ledgers, and reconciliation for synthetic actions. |
| Reliability tooling | Tracks local SLO samples, cost attribution, runtime health, backups, inventory, and attack-path metadata. |

<p align="center">
  <img src="docs/assets/landing.png" alt="GhostAPI landing page showing the local API workflow for coding agents">
</p>

## Dashboard

The dashboard is the fastest way to understand what an agent or application actually did.

- Watch traffic arrive in real time over SSE.
- Inspect sanitized request and response JSON.
- Filter by Stripe, Twilio, Resend, GitHub, Discord, OpenAI, or generic REST.
- Generate a Vitest test from a captured request.
- Generate and copy setup files for supported coding agents.
- Arm deterministic scenario presets.
- Toggle Chaos Mode and inspect the local safety report.

Dashboard and API routes are token-protected on every non-loopback bind. Use HTTPS or a secure tunnel when exposing GhostAPI beyond localhost.

## Provider Support

GhostAPI has two levels of provider support.

### Stateful provider packs

| Provider | Included behavior |
| --- | --- |
| Stripe | Customers, products, prices, subscriptions, invoices, payment intents, payment methods, checkout sessions, refunds, pagination, lifecycle scenarios, and signed local webhooks. |
| Resend | Deterministic email-shaped requests, responses, validation, and failure behavior. |

### Provider-shaped adapters and generic inference

OpenAI, Twilio, GitHub, Discord, and generic REST routes are detected and receive provider-shaped mock responses and errors. These adapters are useful for local development, but they do not claim complete parity with every live-provider endpoint.

Unsupported endpoints fail diagnostically instead of silently pretending that an operation succeeded.

## SDK Setup

Stripe:

```ts
import Stripe from "stripe";

export const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY ?? "stripe_test_ghostapi",
  {
    host: process.env.GHOSTAPI_HOST ?? "127.0.0.1",
    port: Number(process.env.GHOSTAPI_PORT ?? "8080"),
    protocol: process.env.GHOSTAPI_PROTOCOL ?? "http"
  }
);
```

OpenAI:

```ts
import OpenAI from "openai";

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "sk-ghostapi",
  baseURL: process.env.GHOSTAPI_OPENAI_BASE_URL ?? "http://127.0.0.1:8080/v1"
});
```

Generic REST:

```bash
curl -X POST http://127.0.0.1:8080/tasks \
  -H "content-type: application/json" \
  -d '{"title":"Add integration tests","status":"open"}'
```

## MCP For Agents

Start the MCP server:

```bash
npx @yiaany/ghostapi mcp
```

Generic MCP configuration:

```json
{
  "mcpServers": {
    "ghostapi": {
      "command": "npx",
      "args": ["-y", "@yiaany/ghostapi", "mcp"]
    }
  }
}
```

Available tools:

| Tool | Purpose |
| --- | --- |
| `inspect_state` | Read current local API objects. |
| `get_traffic_logs` | Inspect sanitized recent traffic. |
| `set_api_behavior` | Force a deterministic response for a method and path. |
| `toggle_chaos_mode` | Enable or disable local latency and failure injection. |

Generate setup snippets for Cursor, Claude, Cline, Aider, Codex, OpenCode, Gemini CLI, Goose, OpenClaw, Hermes, and generic MCP clients:

```bash
npx @yiaany/ghostapi setup --write
```

## Scenarios, Contracts, And Evals

Record approved sandbox traffic into a sanitized offline bundle:

```bash
ghostapi record \
  --input capture.har \
  --allow-sandbox-host api.sandbox.example \
  --approve
```

Replay it without network access:

```bash
ghostapi replay bundle.json --requests requests.json
```

Import and compare API contracts:

```bash
ghostapi contract import-openapi --input openapi.json
ghostapi contract diff \
  --baseline base.contract.json \
  --candidate head.contract.json \
  --policy ghostapi.policy.yaml \
  --ci
```

Generate sanitized CI evidence:

```bash
ghostapi evidence generate --policy ghostapi.policy.yaml --ci
```

Run a deterministic agent eval:

```bash
ghostapi eval \
  --template retry-after \
  --evidence .ghostapi/reports/latest.json \
  --ci
```

## Safety Boundaries

GhostAPI is designed to fail closed, but its boundaries are explicit:

- Real provider calls are disabled by default.
- Ambient `OPENAI_API_KEY` does not enable external generation.
- External LLM generation requires an explicit flag plus a separate `GHOSTAPI_LLM_API_KEY`.
- Non-loopback access requires a strong dashboard token.
- External response redirects, unsafe response headers, traversal, remote schema references, symlinks, archives, and oversized inputs are rejected where applicable.
- Persistent stores have size, entry, retention, or rotation limits.
- The Linux `run` backend provides loopback-only process network isolation when namespace preflight succeeds.
- `run` is not a hostile-code filesystem sandbox.
- Secret masking is heuristic. Use synthetic credentials and data even in local fixtures.
- Local approval, action, credential, ledger, trust, and safety components execute synthetic operations only. They are not a production-provider executor.

Read the detailed threat models in [`docs/security`](docs/security) and the reporting policy in [`SECURITY.md`](SECURITY.md).

## Platform Support

| Platform | Local API and dashboard | `ghostapi run` enforcement |
| --- | --- | --- |
| Linux | Supported on Node.js 20+ | Supported when `unshare`, `iproute2`, and namespace preflight pass. |
| Windows | Supported on Node.js 20+ | Not implemented; fails closed. |
| macOS | Supported on Node.js 20+ | Not implemented; fails closed. |

Check the current machine:

```bash
ghostapi doctor --json
ghostapi doctor --egress
```

## Health Endpoints

```text
GET /health             process liveness, HTTP 200 while state can be evaluated
GET /health/readiness   structural readiness, HTTP 503 when a required store is unsafe
```

## Hosted And Enterprise

The `hosted/` directory contains an implemented but not yet deployed team pilot. It includes:

- organizations, projects, invitations, memberships, and role-based access;
- tenant-safe report and scenario APIs;
- hashed and rotatable CI ingest keys;
- bounded request handling, CSRF checks, security headers, quotas, and abuse limits;
- PostgreSQL migrations, idempotency, outbox dispatch, worker leases, retries, dead letters, and retention cleanup;
- Redis-backed rate limiting, QStash verification, readiness checks, and a non-root Docker image.

It is not advertised as a production SaaS yet. Live OAuth, Redis, QStash, load, failover, backup/restore, and disaster-recovery behavior must still be proven in staging before a paid pilot.

The detailed product plan for a complete enterprise edition is available in [`docs/enterprise-product-roadmap-ru.md`](docs/enterprise-product-roadmap-ru.md).

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke:package
```

Hosted pilot checks:

```bash
cd hosted
npm ci
npm run check
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/release-readiness.md`](docs/release-readiness.md), and [`docs/development/verification-0.1.8.md`](docs/development/verification-0.1.8.md) for the complete verification boundary.

## Documentation

- [Usage guide](docs/usage.md)
- [MCP setup](docs/mcp.md)
- [Policy reference](docs/policy.md)
- [GitHub Actions integration](docs/github-actions.md)
- [Generic CI integration](docs/ci.md)
- [Stripe provider pack](docs/providers/stripe-core-pack.md)
- [Security policy](SECURITY.md)
- [Threat models](docs/security)
- [Release readiness](docs/release-readiness.md)
- [Migration and rollback](docs/release-migration-and-rollback.md)
- [Enterprise roadmap in Russian](docs/enterprise-product-roadmap-ru.md)

## License

MIT. See [`LICENSE`](LICENSE).
