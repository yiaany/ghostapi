# GhostAPI Website Content

This file contains the English website copy for the public GhostAPI landing page. The homepage should stay focused, sharp, and easy to understand. Deeper technical details belong in docs, GitHub README, or subpages.

## Homepage

### 1. Hero

#### One-Liner

The local internet for AI coding agents.

#### Subline

Build, test, and replay third-party API integrations locally without touching production services, leaking real keys, sending real messages, or charging real cards.

#### Primary CTA

Get Started

#### Secondary CTA

View on GitHub

#### Hero Command

```bash
npx @yiaany/ghostapi start --open
```

#### Visual Placeholder Copy

Show one strong product moment, not a generic dashboard screenshot.

The visual should show three things at once:

- live traffic from a local API request;
- a replayed Stripe payment failure scenario;
- Agent Setup or MCP controls visible in the product.

The point is to make it obvious that GhostAPI is not just a mock server. It is a local API control layer for coding agents.

Suggested caption:

```text
Run GhostAPI locally. Watch every API call. Replay scenarios. Let agents control behavior through MCP.
```

#### Killer Use Case

Cursor writes a Stripe integration. GhostAPI catches the request, returns a realistic payment failure, and the agent fixes the code without ever touching production.

### 2. Problem

AI agents are writing integration code, but production APIs are the wrong place to test it.

- Real provider calls can charge cards, send emails, post messages, mutate repos, or spend API credits.
- Live APIs are slow, flaky, rate-limited, and unsafe for autonomous coding loops.
- Hand-written mocks are brittle, shallow, and hard to keep realistic.

### 3. How It Works

#### Step 1: Start GhostAPI

```bash
npx @yiaany/ghostapi start --open
```

GhostAPI runs locally and opens the dashboard.

#### Step 2: Point Your App At Localhost

Send SDK calls and HTTP requests to:

```text
http://127.0.0.1:8080
```

GhostAPI detects providers like Stripe, Twilio, Resend, GitHub, Discord, OpenAI, and generic REST APIs.

#### Step 3: Inspect, Replay, And Let Agents Control It

Use the dashboard and MCP tools to turn local traffic into repeatable agent workflows: inspect what happened, replay the failure, adjust behavior, and generate a test.

### 4. Core Features

Keep this section to these six features only. Anything else belongs in docs or GitHub README.

#### Local Proxy

Give agents a safe local target instead of production APIs.

#### Provider-Shaped Responses

Return realistic success and failure payloads that look like the providers your app already uses.

#### MCP For Agents

Let agents inspect state, read logs, force responses, and toggle failure modes instead of guessing what happened.

```bash
ghostapi mcp
```

#### Scenarios

Turn common integration flows into repeatable fixtures: payment failure, email send, issue creation, and custom traffic saved from your own app.

#### Chaos Mode

Break the happy path on purpose with rate limits, upstream failures, and latency so retry logic actually gets tested.

#### Live Dashboard

See the agent's API world in real time: every call, every response, every replay, every override.

### 5. Who It's For

Keep this section tight. Three audiences are enough.

#### AI Coding Agents

Give coding agents a safe local API world to inspect, replay, and control.

#### SaaS Developers

Build third-party integrations without risking production data or external side effects.

#### API-Heavy Teams

Create repeatable local scenarios, generate tests from traffic, and keep integration development safe and observable.

### 6. Installation

#### Start Instantly

```bash
npx @yiaany/ghostapi start --open
```

#### Install Globally

```bash
npm install -g @yiaany/ghostapi
ghostapi start --open
```

#### Start MCP

```bash
ghostapi mcp
```

#### Generate Agent Setup

```bash
ghostapi setup --write
```

This generates agent instructions and MCP snippets without overwriting existing files.

### 7. Proof / Screenshot / GIF

This section is critical. Leave a dedicated slot for a short demo video or GIF. The homepage should not only claim the product works; it should show the full control loop.

The visual must read in two seconds. It should not be an abstract dashboard screenshot.

One-frame requirement:

- live traffic is visible;
- a Stripe failure is visible;
- MCP/control is visible;
- replay is visible.

Required storyboard:

- `npx @yiaany/ghostapi start --open`
- dashboard opens;
- Cursor or another agent writes/calls a Stripe integration;
- a request appears in live traffic;
- GhostAPI returns a realistic payment failure;
- the failure is visible in the dashboard;
- MCP/control action or scenario replay is triggered;
- the same failure is replayed deterministically;
- a test is generated from the captured traffic.

Short version:

```text
request -> failure -> dashboard -> MCP/control -> replay -> generated test
```

Suggested caption:

```text
From one unsafe API call to a replayable local scenario in under a minute.
```

### 8. FAQ

#### Is GhostAPI a mock server?

It includes mock behavior, but the bigger idea is a local API world for agents: provider-shaped responses, scenarios, dashboard inspection, MCP control, generated tests, and safety checks.

#### Does GhostAPI call real provider APIs?

No. GhostAPI is local-first and does not call real providers by default.

#### Does it require an LLM key?

No. GhostAPI works with deterministic local mocks. Optional AI generation can be added, but local fallback is always available.

#### Which providers are supported?

Stripe, Twilio, Resend, GitHub, Discord, OpenAI, and generic REST APIs.

#### Which agents does it work with?

GhostAPI works with MCP-compatible clients and provides setup snippets/instructions for Claude, Cursor, Cline, Aider, Codex, OpenCode, Gemini CLI, Goose, OpenClaw, Hermes Desktop, and generic stdio MCP clients.

#### Is it open source?

Yes. GhostAPI is designed as an open-source local developer tool under the MIT license.

## Secondary Pages / Docs Content

The following content should not be front-and-center on the homepage. Put it in docs, GitHub README, or subpages.

### Docs: MCP Setup

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

If running from source:

```json
{
  "mcpServers": {
    "ghostapi": {
      "command": "node",
      "args": ["dist/cli/index.js", "mcp"]
    }
  }
}
```

Generated setup files:

```text
.cursorrules
AGENTS.md
.cursor/mcp.json
cline_mcp_settings.json
claude_desktop_config.json
.ghostapi/agent-configs/universal-mcp.json
.ghostapi/agent-configs/claude-cli.json
.ghostapi/agent-configs/claude-desktop.json
.ghostapi/agent-configs/cline.json
.ghostapi/agent-configs/aider.md
.ghostapi/agent-configs/codex.json
.ghostapi/agent-configs/opencode-cli.json
.ghostapi/agent-configs/opencode-desktop.json
.ghostapi/agent-configs/gemini-cli.json
.ghostapi/agent-configs/goose.json
.ghostapi/agent-configs/openclaw.json
.ghostapi/agent-configs/hermes-desktop.json
```

### Docs: MCP Tools

- `inspect_state`: read local API state.
- `set_api_behavior`: force deterministic responses.
- `get_traffic_logs`: inspect recent API traffic.
- `toggle_chaos_mode`: enable or disable failure injection.

### Docs: CLI Reference

```bash
ghostapi start --open
ghostapi open
ghostapi setup
ghostapi setup --write
ghostapi mcp
ghostapi report
ghostapi doctor
ghostapi init
ghostapi clear cache|state|events|all
ghostapi providers list
ghostapi providers inspect stripe
ghostapi model get
ghostapi model set <model>
```

### Docs: API Endpoints

Core:

```http
GET /health
GET /dashboard
GET /api/events
GET /events
POST /api/clear
```

Agent and setup:

```http
POST /api/setup
POST /api/ai-rules
GET /api/agent-prompt
GET /api/safety-report
```

Scenarios:

```http
GET /api/scenarios
POST /api/scenarios
POST /api/scenarios/save-from-traffic
POST /api/scenarios/:id/replay
GET /api/scenarios/:id/export
POST /api/scenarios/:id/share
```

Tests:

```http
GET /api/events/:id/test
```

Chaos Mode:

```http
GET /api/fault-lab
POST /api/fault-lab
```

### Docs: SDK Examples

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

### Docs: Local Files

```text
.ghostapi/config.json
.ghostapi/state.json
.ghostapi/events.jsonl
.ghostapi/behaviors.json
.ghostapi/scenarios/*.json
.ghostapi/cache/*
.ghostapi/agent-configs/*
```

### Docs: Safety Model

- No real provider calls by default.
- Offline fallback works without an LLM key.
- Secrets are masked before logs, cache, dashboard, event history, and prompts.
- Dashboard mutation APIs reject hostile cross-origin requests.
- Setup writing does not overwrite existing files.
- Chaos Mode is opt-in.
- Safety reports help catch production API usage before launch.

## Launch Copy

### One-Sentence Pitch

GhostAPI is the local internet for AI coding agents.

### Short Pitch

GhostAPI lets developers and AI coding agents build API integrations locally without touching production providers. It simulates Stripe, Twilio, Resend, GitHub, OpenAI, and REST APIs with a live dashboard, MCP tools, replayable scenarios, Chaos Mode, generated tests, safety reports, and secret masking.

### X / Twitter Post

```text
AI coding agents keep touching real APIs.

So I built GhostAPI: a local internet for agents.

Run:
npx @yiaany/ghostapi start --open

It simulates Stripe, Twilio, OpenAI, GitHub, Resend, and REST APIs locally.

Includes dashboard, MCP, scenarios, Chaos Mode, generated tests, safety reports, and secret masking.

MIT open source.
```

### Hacker News Title

```text
Show HN: GhostAPI - a local internet simulator for AI coding agents
```

### Product Hunt Tagline

```text
Build API integrations with AI agents without touching production
```

## Homepage Sections Checklist

- Hero
- Problem
- How It Works
- Core Features
- Who It's For
- Installation
- Proof / Screenshot / GIF
- FAQ

## Keep Off The Homepage

These should live in docs or GitHub README, not the main landing page:

- full CLI reference;
- all MCP snippets;
- full agent support config details;
- enterprise direction;
- full API endpoint list;
- local file internals;
- long safety model details.
