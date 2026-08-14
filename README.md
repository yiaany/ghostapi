<p align="center">
  <img src="docs/assets/ghostapi-avatar.png" alt="GhostAPI" width="104" height="104">
</p>

<h1 align="center">GhostAPI</h1>

<p align="center">
  <strong>The local internet for AI coding agents.</strong>
</p>

<p align="center">
  A local API sandbox, dashboard, and MCP control plane for building third-party integrations without touching production.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@yiaany/ghostapi"><img alt="npm" src="https://img.shields.io/npm/v/@yiaany/ghostapi?color=0f172a&label=npm"></a>
  <a href="https://github.com/yiaany/ghostapi/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-0f172a"></a>
  <a href="https://github.com/yiaany/ghostapi/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/yiaany/ghostapi/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-0f172a">
  <img alt="mcp" src="https://img.shields.io/badge/MCP-enabled-0f172a">
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#mcp-setup">MCP Setup</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#sdk-recipes">SDK Recipes</a> ·
  <a href="#contributing">Contributing</a>
</p>

```bash
npx @yiaany/ghostapi init
npx @yiaany/ghostapi run -- npm test
```

<p align="center">
  <img src="docs/assets/dashboard.png" alt="GhostAPI dashboard showing local API traffic">
</p>

## The Problem

AI coding agents are now strong enough to write Stripe checkouts, OpenAI workflows, GitHub automations, Twilio messaging, and email integrations. The dangerous part is that they also run the code they write.

That creates a bad default loop:

| Agent action | Production risk |
| --- | --- |
| Tests a Stripe flow | Real money movement or broken payment state. |
| Tests Twilio or Resend | Real SMS or email sent to real people. |
| Tests GitHub automation | Real issues, branches, releases, or repo mutations. |
| Tests OpenAI calls | Real token spend and possible prompt/data leakage. |
| Logs request/response payloads | Secrets leak into terminals, prompts, screenshots, or cache. |

GhostAPI gives agents a local universe where integrations behave like real providers, but every request stays on your machine.

On supported Linux hosts, `ghostapi run -- <command>` adds a loopback-only namespace boundary for a target process and its ordinary descendants. It fails closed when that boundary cannot be created; it is not a proxy fallback or a hostile-code filesystem sandbox. See the [egress threat model](docs/security/egress-threat-model.md).

Use [`ghostapi.policy.yaml`](docs/policy.md) to keep network, credential and required-scenario decisions versioned, deterministic and reviewable.

Generate CI-ready evidence with `ghostapi evidence generate --policy ghostapi.policy.yaml --ci`; the JSON artifact is redacted, canonicalized and rejected if later corrupted.

Use the [GitHub Actions PR safety check](docs/github-actions.md) to make an enforced run plus sanitized evidence a required status check, or follow the [generic CI guide](docs/ci.md) on another CI platform.

Turn explicitly allowed sandbox JSON/HAR traffic into a portable deterministic bundle with `ghostapi record --input capture.har --allow-sandbox-host api.sandbox.example --approve`, then run it offline with `ghostapi replay bundle.json --requests requests.json`. The recorder removes secrets, redacts default PII categories, variables unstable IDs/timestamps, omits binary/multipart bodies, blocks external redirects, and requires approval when its sanitization summary found potentially sensitive traffic. It never records production hosts by default or persists raw temporary payloads. See the [record and replay guide](docs/usage.md#record-and-replay-sandbox-traffic).

Import a bounded OpenAPI 3.0 JSON subset or a sanitized HAR into deterministic contracts using `ghostapi contract import-openapi` and `ghostapi contract import-har`, then run `ghostapi contract diff --baseline base.contract.json --candidate head.contract.json --policy ghostapi.policy.yaml --ci`. The importer never resolves `$ref` or remote URLs; unsupported features fail closed. Contract diffs classify endpoint, request/response schema, enum/status, and provider-pack capability drift as breaking, non-breaking, or uncertain, and can be included in `ghostapi evidence generate` for CI policy enforcement. See the [contract guide](docs/usage.md#contract-import-and-drift).

Score agent behavior with deterministic evals using `ghostapi eval --template retry-after --evidence .ghostapi/reports/latest.json --ci` or a local JSON spec. Core security scoring depends only on sanitized evidence, not an LLM judge, and forbidden actions such as production egress or secret leakage override cosmetic success. See the [agent eval guide](docs/usage.md#agent-evals).

Create a deterministic, local shared state with `ghostapi world create --id subscription-recovery --seed demo-seed`. A world uses one canonical synthetic identity across Stripe, GitHub, email, and generic REST projections; it supports atomic local transitions, reset, and snapshot forks without cloud tenancy or real PII. See the [synthetic world guide](docs/usage.md#stateful-synthetic-worlds) and [end-to-end example](examples/worlds/README.md).

The local `ghostapi action` gateway uses a versioned action envelope, canonical hash, structured approval, policy/evidence references, identity recheck, idempotency, and receipt chain to execute one synthetic-world operation. It has no real-provider executor, credentials, or outbound side effect. See the [synthetic action gateway guide](docs/usage.md#synthetic-action-gateway) and [threat model](docs/security/action-gateway-threat-model.md).

The public credential-broker library keeps provider secret material behind an injected vault boundary and executes through a server-side executor rather than returning a secret or grant to an agent. The shipped implementation has no CLI, MCP, provider, HTTP, environment-secret, or production side-effect path; its in-memory vault/provider adapters are tests only. See the [credential broker guide](docs/usage.md#credential-broker-and-workload-identity) and [threat model](docs/security/credential-broker-threat-model.md).

The [design-partner validation kit](docs/design-partners/README.md) currently records no independently verifiable interview, CI, bug-caught, LOI, or paid-pilot evidence in this repository, so the cloud/enterprise gate remains unmet. The local typed [team-control-plane prototype](docs/team-control-plane.md) remains local-first, while the separate [hosted pilot architecture](docs/hosted-pilot.md) is an un-deployed technical design whose RPO/RTO targets remain unproven until production-equivalent load and disaster-recovery drills pass.

## What GhostAPI Does

GhostAPI is a local API control layer for agent-driven development.

<table>
  <tr>
    <td><strong>Local API Sandbox</strong><br>Run provider-shaped APIs on <code>127.0.0.1:8080</code> instead of live Stripe, OpenAI, Twilio, Resend, GitHub, Discord, or random REST services.</td>
    <td><strong>Live Dashboard</strong><br>Watch every request, inspect request and response bodies, replay scenarios, generate setup snippets, and verify what your agent actually did.</td>
  </tr>
  <tr>
    <td><strong>MCP Control Plane</strong><br>Let agents inspect state, read traffic logs, force deterministic responses, and toggle Chaos Mode through MCP tools.</td>
    <td><strong>Safe Failure Testing</strong><br>Force card declines, rate limits, upstream errors, latency, and provider-shaped edge cases without waiting for real APIs to fail.</td>
  </tr>
  <tr>
    <td><strong>Secret Masking</strong><br>Mask secret-looking headers, query params, bodies, cache keys, dashboard payloads, events, and prompt inputs.</td>
    <td><strong>Repo Setup Generator</strong><br>Generate MCP config, agent instructions, environment snippets, and SDK patches for the current project.</td>
  </tr>
</table>

## Quickstart

Initialize a project without production credentials:

```bash
npx @yiaany/ghostapi init
npx @yiaany/ghostapi doctor
npx @yiaany/ghostapi run -- npm test
```

`init` creates `.ghostapi/config.json`, `ghostapi.policy.yaml`, MCP snippets, and agent instructions without overwriting existing files. `run` is enforced only on supported Linux hosts; on Windows and macOS it fails closed instead of pretending to isolate the process.

If `doctor` reports unsupported enforcement, start the local provider-shaped API directly:

```bash
npx @yiaany/ghostapi start --open
```

Install globally:

```bash
npm i -g @yiaany/ghostapi
ghostapi start --open
```

Open the dashboard:

```text
http://127.0.0.1:8080/dashboard
```

Health check:

```bash
curl http://127.0.0.1:8080/health
```

## 30 Second Demo

Start the local API world:

```bash
npx @yiaany/ghostapi start --open
```

Send a Stripe-shaped request locally:

```bash
curl -X POST http://127.0.0.1:8080/v1/customers \
  -H "content-type: application/json" \
  -H "authorization: Bearer stripe_test_ghostapi" \
  -d '{"email":"ada@example.com","name":"Ada Lovelace"}'
```

Inspect the captured request in the dashboard:

```text
http://127.0.0.1:8080/dashboard
```

## One-Command Repo Setup

Run setup inside any project if you want to regenerate setup assets without touching `.ghostapi/config.json`:

```bash
npx @yiaany/ghostapi setup --write
```

This generates local setup assets for agent workflows:

| Output | Why it matters |
| --- | --- |
| Agent instructions | Tell coding agents to keep provider calls local. |
| MCP snippets | Configure Cursor, Claude, Cline, Aider, Codex, OpenCode, Gemini CLI, Goose, OpenClaw, Hermes, and generic MCP clients. |
| Environment snippets | Point SDKs at `http://127.0.0.1:8080`. |
| SDK patches | Show how to route Stripe and OpenAI SDKs into GhostAPI. |
| Safety guidance | Warn before live providers or live-looking keys enter the loop. |

## MCP Setup

Start the MCP server:

```bash
npx @yiaany/ghostapi mcp
```

Universal MCP config:

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

Agent prompt:

```text
Use the GhostAPI MCP server.

Keep all third-party API calls local on http://127.0.0.1:8080.
Do not call real providers.

Use GhostAPI MCP tools to inspect state, read traffic logs, configure deterministic responses, and test failure scenarios.
```

MCP tools:

| Tool | Purpose |
| --- | --- |
| `inspect_state` | Read local API objects from `.ghostapi/state.json`. |
| `get_traffic_logs` | Inspect recent local traffic. |
| `set_api_behavior` | Force deterministic responses for `method + path`. |
| `toggle_chaos_mode` | Enable local latency and provider-shaped errors. |

## How It Works

```text
Your app or agent
  -> http://127.0.0.1:8080
  -> GhostAPI proxy
  -> provider detection
  -> local state / scenarios / deterministic behavior
  -> dashboard + MCP inspection
```

GhostAPI does five things in the loop:

| Step | What happens |
| --- | --- |
| Detect | It infers the provider from routes, headers, SDK shapes, and request bodies. |
| Normalize | It converts requests into safe, inspectable local events. |
| Mask | It strips secret-looking values before logs, cache, dashboard, and prompts. |
| Respond | It returns provider-shaped mock responses, errors, or saved state. |
| Control | MCP and dashboard tools let agents force behavior and replay flows. |

## SDK Recipes

Stripe:

```ts
import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "stripe_test_ghostapi", {
  host: process.env.GHOSTAPI_HOST ?? "127.0.0.1",
  port: Number(process.env.GHOSTAPI_PORT ?? "8080"),
  protocol: process.env.GHOSTAPI_PROTOCOL ?? "http"
});
```

The Stripe billing pack supports deterministic Customers, Products, Prices, Subscriptions, Invoices, Payment Intents, Payment Methods, Checkout Sessions, Refunds, and local signed webhook delivery using `2026-02-25.clover`. Unsupported endpoints fail diagnostically rather than returning generated success. See [`docs/providers/stripe-core-pack.md`](docs/providers/stripe-core-pack.md) and the runnable [`examples/stripe-node`](examples/stripe-node) flow.

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
  -d '{"title":"Write integration tests","status":"open"}'
```

## Built For

| Audience | Use GhostAPI to |
| --- | --- |
| AI coding agents | Build integrations without accidentally touching production. |
| SaaS developers | Test provider happy paths and failure paths locally. |
| API-heavy teams | Turn captured traffic into repeatable scenarios and tests. |
| Open-source maintainers | Give contributors safe examples that do not require live provider accounts. |

## Safety Model

- No real provider calls by default.
- Ambient `OPENAI_API_KEY` does not enable outbound traffic. External LLM generation requires `--allow-external-llm` or `GHOSTAPI_ALLOW_EXTERNAL_LLM=true` plus `GHOSTAPI_LLM_API_KEY`.
- Keep SDKs pointed at `http://127.0.0.1:8080`.
- Use fake local keys like `stripe_test_ghostapi` and `sk-ghostapi`.
- Secrets are masked before logs, cache, dashboard, events, and prompts.
- Chaos Mode is opt-in.
- Local state defaults to `.ghostapi/`, is gitignored, and can be isolated with `GHOSTAPI_DATA_DIR`.
- Non-loopback dashboard access requires a strong `GHOSTAPI_AUTH_TOKEN` and should use HTTPS or a secure tunnel.
- GhostAPI is not a host-level network-isolation boundary; provider simulation routes follow the configured bind address. On a remote bind with external LLM generation enabled, proxy requests also require the dashboard token.

## Platform Support

| Platform | `start` / local provider simulation | `run` process egress enforcement |
| --- | --- | --- |
| Linux | Supported on Node.js 20+ | Experimental/supported only when `unshare`, `iproute2`, and user/mount/network/PID namespace preflight pass. |
| Windows | Supported on Node.js 20+ | Unsupported; AppContainer launcher is not implemented. |
| macOS | Supported on Node.js 20+ | Unsupported/experimental; arbitrary-child App Sandbox enforcement is not implemented. |

Run `npx @yiaany/ghostapi doctor --json` for machine-readable environment checks and `npx @yiaany/ghostapi doctor --egress` for detailed enforcement capability diagnostics.

## Local Files

| Path | Purpose |
| --- | --- |
| `.ghostapi/config.json` | Local GhostAPI config. |
| `.ghostapi/state.json` | Simulated API object state. |
| `.ghostapi/events.jsonl` | Captured local request events; 5 MiB active file plus two archives. |
| `.ghostapi/reports/` | Versioned evidence reports; 512 KiB per artifact with latest-20 local retention. |
| `.ghostapi/scenarios/*.bundle.json` | Sanitized, versioned record/replay bundles; no raw temporary capture is retained. |
| `.ghostapi/contracts/*.contract.json` | Bounded deterministic OpenAPI/HAR contract snapshots for offline drift checks. |
| `.ghostapi/actions/*.action.json` | Synthetic action envelopes, structured approvals, and tamper-evident local receipt chains. |
| `.ghostapi/credential-broker.json` | Credential metadata, scoped server-only grants, and action-linked execution receipts; never upstream secret material. |
| `.ghostapi/behaviors.json` | Deterministic behavior overrides. |
| `.ghostapi/cache/` | Local response cache. |
| `.ghostapi/fault-lab.json` | Persisted Fault Lab configuration shared with MCP. |
| `.ghostapi/product-telemetry.json` | Optional local aggregate counters; disabled by default, never uploaded, and deleted by `ghostapi telemetry disable`. |

On POSIX systems GhostAPI requests owner-only permissions. On Windows, effective permissions inherit from the data directory ACL. Local lock files coordinate cooperating processes on one filesystem, not distributed or synchronized copies.

## Uninstall And Cleanup

```bash
npm uninstall -g @yiaany/ghostapi
rm -rf .ghostapi
```

If `init` created repo setup files you no longer want, remove `ghostapi.policy.yaml`, generated MCP snippets, and generated agent instruction files after reviewing any local edits. On Windows, delete `.ghostapi` with Explorer or PowerShell if `rm` is unavailable.

## CLI Reference

```bash
npx @yiaany/ghostapi start --open
npx @yiaany/ghostapi init
npx @yiaany/ghostapi doctor --json
npx @yiaany/ghostapi run -- npm test
npx @yiaany/ghostapi start --allow-external-llm
npx @yiaany/ghostapi open
npx @yiaany/ghostapi setup --write
npx @yiaany/ghostapi mcp
npx @yiaany/ghostapi report
npx @yiaany/ghostapi evidence generate --policy ghostapi.policy.yaml --ci
npx @yiaany/ghostapi evidence view .ghostapi/reports/latest.json
npx @yiaany/ghostapi evidence compare .ghostapi/reports/base.json .ghostapi/reports/head.json
npx @yiaany/ghostapi record --input capture.har --allow-sandbox-host api.sandbox.example --approve
npx @yiaany/ghostapi replay .ghostapi/scenarios/sandbox-recording.bundle.json --requests requests.json
npx @yiaany/ghostapi contract import-openapi --input openapi.json
npx @yiaany/ghostapi contract diff --baseline base.contract.json --candidate head.contract.json --policy ghostapi.policy.yaml --ci
npx @yiaany/ghostapi action inspect <action-id>
npx @yiaany/ghostapi doctor --port 8080
npx @yiaany/ghostapi clear cache|state|events|all
npx @yiaany/ghostapi providers list
npx @yiaany/ghostapi providers inspect stripe
```

## Repository About

Use this for the GitHub repository description:

```text
The local internet for AI coding agents. Simulate Stripe, OpenAI, Twilio, Resend, GitHub, Discord, and REST APIs locally with a dashboard, MCP tools, scenarios, and secret masking.
```

Recommended topics:

```text
mcp, ai-agents, stripe, openai, mock-server, api-testing, sandbox, proxy, local-development, typescript, cursor
```

## Docs

- [MCP setup](docs/mcp.md)
- [Usage guide](docs/usage.md)
- [GitHub Actions PR safety check](docs/github-actions.md)
- [Generic CI guide](docs/ci.md)
- [Starter examples](examples/README.md)
- [Design-partner validation kit](docs/design-partners/README.md)
- [Commercial readiness and pricing experiment](docs/commercial/README.md)
- [Launch and fundraising package](docs/fundraising/README.md)
- [Provider pack authoring](docs/providers/authoring-packs.md)
- [Release checklist](docs/release-checklist.md)
- [Synthetic action gateway threat model](docs/security/action-gateway-threat-model.md)
- [Release readiness](docs/release-readiness.md)
- [Migration and rollback](docs/release-migration-and-rollback.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Contributing

Contributions are welcome. GhostAPI should stay local-first, safe by default, and useful for real agent workflows.

Before opening a pull request:

```bash
npm run typecheck
npm test
npm run build
```

Do not add tests or examples that call live providers by default. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

## License

MIT. See [LICENSE](LICENSE).
