# GhostAPI

**Local API simulation and test evidence for AI-assisted development.**

GhostAPI gives applications and coding agents a local target for selected Stripe, Resend, OpenAI, Twilio, GitHub, Discord, and generic REST workflows. It records heuristically sanitized traffic, injects deterministic failures, exposes MCP controls, and turns captured behavior into repeatable tests.

On supported Linux hosts, `ghostapi run` can execute a test command inside a loopback-only network namespace. It is not a hostile-code or filesystem sandbox.

<p align="center">
  <a href="https://www.npmjs.com/package/@yiaany/ghostapi"><img alt="npm" src="https://img.shields.io/npm/v/@yiaany/ghostapi?color=0f172a&label=npm"></a>
  <a href="https://github.com/yiaany/ghostapi/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-0f172a"></a>
  <a href="https://github.com/yiaany/ghostapi/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/yiaany/ghostapi/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-0f172a">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-enabled-0f172a">
</p>

[Quickstart](#quickstart) · [Security model](SECURITY.md) · [Provider coverage](docs/providers/) · [Release evidence](docs/releases/)

```bash
npx @yiaany/ghostapi start --open
```

<p align="center">
  <img src="docs/assets/dashboard.png" alt="GhostAPI dashboard with live local Stripe, OpenAI, and REST traffic">
</p>

## Why GhostAPI

Coding agents can write a Stripe checkout, an OpenAI workflow, a GitHub automation, or an email integration in minutes. The dangerous part is what happens when they run that code.

When a client is configured against a live provider, a test can:

- charge a real card;
- send a real email or SMS;
- create or modify real GitHub resources;
- spend API credits;
- leak credentials into logs, prompts, screenshots, or test fixtures.

GhostAPI provides a local endpoint at `127.0.0.1:8080`. Requests sent to that endpoint are classified, heuristically sanitized, recorded in bounded local stores, and answered by implemented provider packs or generic fallback behavior. You can inspect the result in the dashboard, control local behavior through MCP, and turn captured failures into repeatable tests.

## Verified Locally, Not Customer-Validated Yet

The public repository contains reproducible tests for local provider simulation, Linux namespace enforcement, package installation, and hosted-pilot authorization. GhostAPI does not yet claim production customers, paid pilots, or a deployed team service.

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

| Feature                     | What it does                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Local API simulation        | Gives explicitly configured SDKs and applications a local target instead of a live provider.                                              |
| Provider-shaped behavior    | Returns deterministic objects and errors shaped like the implemented subset of each provider API; it does not claim live-provider parity. |
| Live dashboard              | Shows requests and responses, filters traffic by provider, generates tests, and arms scenarios.                                           |
| MCP control plane           | Lets compatible coding agents inspect state, read traffic, configure responses, and toggle Chaos Mode.                                    |
| Stateful synthetic worlds   | Maintains deterministic local identities and state across Stripe, GitHub, email, and REST projections.                                    |
| Scenarios and record/replay | Saves sanitized sandbox traffic and replays it offline as deterministic fixtures.                                                         |
| Contract drift checks       | Imports bounded OpenAPI/HAR contracts and classifies breaking, non-breaking, and uncertain changes.                                       |
| Agent evals and evidence    | Produces bounded reports with a local self-consistency hash, verifiable while the runtime and local storage remain trusted.               |
| Secret-risk reduction       | Heuristically masks recognized secret-shaped headers, query parameters, bodies, paths, events, prompts, and cache inputs.                 |
| Fault testing               | Forces latency, provider errors, card declines, rate limits, and other unhappy paths.                                                     |
| Safety controls             | Includes local approvals, scoped budgets, kill switches, circuit breakers, ledgers, and reconciliation for synthetic actions.             |
| Reliability tooling         | Tracks local SLO samples, cost attribution, runtime health, backups, inventory, and attack-path metadata.                                 |

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

| Provider | Included behavior                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe   | Customers, products, prices, subscriptions, invoices, payment intents, payment methods, checkout sessions, refunds, pagination, lifecycle scenarios, and signed local webhooks. |
| Resend   | Deterministic email-shaped requests, responses, validation, and failure behavior.                                                                                               |

### Provider-shaped adapters and generic inference

OpenAI, Twilio, GitHub, Discord, and generic REST routes are detected and receive provider-shaped synthetic responses and errors. These adapters are useful for local development, but they do not claim complete parity with live-provider endpoints.

Unsupported Stripe and Resend pack operations fail diagnostically. Legacy adapters and generic REST inference may return a synthetic fallback response for unrecognized routes; such responses do not indicate provider support or parity.

## SDK Setup

Stripe:

```ts
import Stripe from "stripe";

export const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY ?? "stripe_test_ghostapi",
  {
    host: process.env.GHOSTAPI_HOST ?? "127.0.0.1",
    port: Number(process.env.GHOSTAPI_PORT ?? "8080"),
    protocol: process.env.GHOSTAPI_PROTOCOL ?? "http",
  },
);
```

OpenAI:

```ts
import OpenAI from "openai";

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "sk-ghostapi",
  baseURL: process.env.GHOSTAPI_OPENAI_BASE_URL ?? "http://127.0.0.1:8080/v1",
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
      "args": ["-y", "@yiaany/ghostapi@0.1.9", "mcp"]
    }
  }
}
```

Available tools:

| Tool                | Purpose                                                |
| ------------------- | ------------------------------------------------------ |
| `inspect_state`     | Read current local API objects.                        |
| `get_traffic_logs`  | Inspect sanitized recent traffic.                      |
| `set_api_behavior`  | Force a deterministic response for a method and path.  |
| `toggle_chaos_mode` | Enable or disable local latency and failure injection. |

Generate setup snippets for Cursor, Claude, Cline, Aider, Codex, OpenCode, Gemini CLI, Goose, OpenClaw, Hermes, and generic MCP clients:

```bash
npx @yiaany/ghostapi setup --write
```

Connect only trusted local MCP clients. MCP tools can read retained traffic and state and can modify local simulation behavior; MCP is not an authentication or egress boundary. Pin the package version in persistent MCP configuration or use a reviewed local installation.

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

## Security Boundaries

GhostAPI uses local-first defaults, explicit external-LLM opt-in, and heuristic secret masking. Its boundaries are explicit:

- Real provider calls are disabled by default.
- Ambient `OPENAI_API_KEY` does not enable external generation.
- External LLM generation requires an explicit flag plus a separate `GHOSTAPI_LLM_API_KEY`.
- On non-loopback binds, every route except `/` and `/health` requires a strong `GHOSTAPI_AUTH_TOKEN`. The token provides access control, not encryption.
- External response redirects, unsafe response headers, traversal, remote schema references, symlinks, archives, and oversized inputs are rejected where applicable.
- Persistent stores have size, entry, retention, or rotation limits.
- The Linux `run` backend provides loopback-only process network isolation when namespace preflight succeeds.
- `run` is not a hostile-code filesystem sandbox.
- Secret masking is heuristic and incomplete. Use synthetic credentials and data even in local fixtures.
- Local approval, action, credential, ledger, trust, and safety components execute synthetic operations only. They are not a production-provider executor.
- Evidence hashes are local self-consistency checks, not signatures, immutable provenance, or proof against a same-user editor.
- Current run evidence records namespace lifecycle and GhostAPI-local traffic; it does not enumerate kernel-denied socket attempts.

Read the detailed threat models in [`docs/security`](docs/security) and the reporting policy in [`SECURITY.md`](SECURITY.md).

## Explicit Non-Goals

- No live-provider parity guarantee.
- No complete secret-redaction guarantee.
- No hostile-code filesystem sandbox.
- No equivalent process-egress enforcement on Windows or macOS.
- No deployed hosted service, SLA, compliance certification, or production credential executor.

## Platform Support

| Platform | Local API and dashboard  | `ghostapi run` enforcement                                          |
| -------- | ------------------------ | ------------------------------------------------------------------- |
| Linux    | Supported on Node.js 20+ | Supported when `unshare`, `iproute2`, and namespace preflight pass. |
| Windows  | Supported on Node.js 20+ | Not implemented; fails closed.                                      |
| macOS    | Supported on Node.js 20+ | Not implemented; fails closed.                                      |

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

## Hosted Experiment

No hosted or enterprise service is currently available. The `hosted/` directory is an undeployed experimental implementation, excluded from the npm package and unsupported for production use. Its live OAuth, dependency, migration, load, failover, backup, and disaster-recovery behavior has not been proven in staging.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run smoke:package
```

Hosted pilot checks:

```bash
cd hosted
npm ci
npm run check
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md), [`PROVENANCE.md`](PROVENANCE.md), and [`docs/releases/`](docs/releases/) for the contribution and release boundaries.

## Documentation

- [Usage guide](docs/usage.md)
- [MCP setup](docs/mcp.md)
- [Policy reference](docs/policy.md)
- [GitHub Actions integration](docs/github-actions.md)
- [Generic CI integration](docs/ci.md)
- [Stripe provider pack](docs/providers/stripe-core-pack.md)
- [Security policy](SECURITY.md)
- [Threat models](docs/security)
- [Project provenance](PROVENANCE.md)
- [Release evidence](docs/releases/)
- [Release readiness](docs/release-readiness.md)
- [Migration and rollback](docs/release-migration-and-rollback.md)

## License

MIT. See [`LICENSE`](LICENSE).
