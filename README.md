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
npx @yiaany/ghostapi start --open
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

Run GhostAPI instantly:

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

Run setup inside any project:

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
- Keep SDKs pointed at `http://127.0.0.1:8080`.
- Use fake local keys like `stripe_test_ghostapi` and `sk-ghostapi`.
- Secrets are masked before logs, cache, dashboard, events, and prompts.
- Chaos Mode is opt-in.
- Local state lives under `.ghostapi/` and is gitignored.

## Local Files

| Path | Purpose |
| --- | --- |
| `.ghostapi/config.json` | Local GhostAPI config. |
| `.ghostapi/state.json` | Simulated API object state. |
| `.ghostapi/events.jsonl` | Captured local request events. |
| `.ghostapi/behaviors.json` | Deterministic behavior overrides. |
| `.ghostapi/cache/` | Local response cache. |

## CLI Reference

```bash
npx @yiaany/ghostapi start --open
npx @yiaany/ghostapi open
npx @yiaany/ghostapi setup --write
npx @yiaany/ghostapi mcp
npx @yiaany/ghostapi report
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
- [Release checklist](docs/release-checklist.md)
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
