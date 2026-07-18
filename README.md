<p align="center">
  <img src="docs/assets/ghostapi-avatar.png" alt="GhostAPI" width="96" height="96">
</p>

<h1 align="center">GhostAPI</h1>

<p align="center">
  <strong>The local internet for AI coding agents.</strong>
</p>

<p align="center">
  Build and test API integrations locally without charging real cards, sending real emails, mutating real repos, burning real tokens, or leaking production keys.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@yiaany/ghostapi"><img alt="npm" src="https://img.shields.io/npm/v/@yiaany/ghostapi?color=111827&label=npm"></a>
  <a href="https://github.com/yiaany/ghostapi/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-111827"></a>
  <a href="https://github.com/yiaany/ghostapi/actions"><img alt="ci" src="https://img.shields.io/badge/CI-ready-111827"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-111827">
</p>

```bash
npx @yiaany/ghostapi start --open
```

<p align="center">
  <img src="docs/assets/dashboard.png" alt="GhostAPI dashboard showing local API traffic">
</p>

## Why GhostAPI

AI agents are now good enough to write integration code. The dangerous part is that they also run it.

GhostAPI gives agents a safe local world:

- A local API server on `http://127.0.0.1:8080`.
- Provider-shaped responses for Stripe, OpenAI, Twilio, Resend, GitHub, Discord, and generic REST APIs.
- A live dashboard for traffic, request/response inspection, scenarios, safety reports, and setup generation.
- An MCP server so agents can inspect state, read traffic, force responses, and test failure paths.
- Secret masking before logs, cache, dashboard, events, and prompts.

```text
Your app or agent -> http://127.0.0.1:8080 -> GhostAPI -> local state, scenarios, dashboard, MCP tools
```

## Install

Run instantly:

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

Check health:

```bash
curl http://127.0.0.1:8080/health
```

## 30 Second Win

Start GhostAPI:

```bash
npx @yiaany/ghostapi start --open
```

Send a Stripe-shaped local request:

```bash
curl -X POST http://127.0.0.1:8080/v1/customers \
  -H "content-type: application/json" \
  -H "authorization: Bearer stripe_test_ghostapi" \
  -d '{"email":"ada@example.com","name":"Ada Lovelace"}'
```

Open the dashboard and inspect the request:

```text
http://127.0.0.1:8080/dashboard
```

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

Generate repo-specific MCP and agent snippets:

```bash
npx @yiaany/ghostapi setup --write
```

Generated setup covers Cursor, Claude, Cline, Aider, Codex, OpenCode, Gemini CLI, Goose, OpenClaw, Hermes Desktop, and generic stdio MCP clients.

## Agent Prompt

```text
Use the GhostAPI MCP server.

Keep all third-party API calls local on http://127.0.0.1:8080.
Do not call real providers.

Use GhostAPI MCP tools to inspect state, read traffic logs, configure deterministic responses, and test failure scenarios.
```

## SDK Examples

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

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `inspect_state` | Read local API objects from `.ghostapi/state.json`. |
| `get_traffic_logs` | Inspect recent local traffic. |
| `set_api_behavior` | Force deterministic responses for `method + path`. |
| `toggle_chaos_mode` | Enable local latency and provider-shaped errors. |

## CLI

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

## Docs

- [MCP setup](docs/mcp.md)
- [Usage guide](docs/usage.md)
- [Release checklist](docs/release-checklist.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Contributing

Contributions are welcome. Keep GhostAPI local-first, safe by default, and useful for real agent workflows.

Before opening a pull request:

```bash
npm run typecheck
npm test
npm run build
```

Do not add tests or examples that call live providers by default. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

## License

MIT. See [LICENSE](LICENSE).
