# GhostAPI Discord Server Setup

Готовая структура Discord-сервера для GhostAPI: саппорт, комьюнити, фидбек, feature requests, баги, MCP/agent setup и announcements.

## Цель Сервера

Discord нужен для:

- поддержки пользователей;
- сбора багов;
- сбора идей и feature requests;
- помощи с MCP setup;
- общения с разработчиками и AI-agent пользователями;
- анонсов релизов;
- превращения ранних пользователей в комьюнити.

## Название Сервера

```text
GhostAPI
```

## Server Description

```text
GhostAPI is the local internet for AI coding agents. Build, test, inspect, and replay API integrations locally without touching production services.
```

## Роли

### Core Roles

```text
Founder
Team
Moderator
Contributor
Early User
Community
```

### Product Roles

```text
MCP User
Stripe User
OpenAI User
GitHub User
Discord User
Twilio User
Resend User
Generic REST User
```

### Notification Roles

```text
Release Updates
Beta Features
Help Wanted
```

## Permissions

### Founder

- admin;
- manage channels;
- manage roles;
- manage webhooks;
- publish announcements.

### Team

- manage messages;
- reply in support;
- close/resolved support threads;
- post in announcements if needed.

### Moderator

- manage messages;
- timeout users;
- handle spam;
- move posts to correct channels.

### Contributor

- visible badge for trusted open-source contributors;
- can post links in showcase and dev channels.

### Community / Early User

- normal member permissions;
- create threads in support/bugs/feature requests.

## Server Categories And Channels

## 1. START HERE

### `#welcome`

Purpose: первое место, куда попадает пользователь.

Channel type: text, read-only.

Pinned message:

```text
Welcome to GhostAPI.

GhostAPI is the local internet for AI coding agents.

Use it to build, test, inspect, and replay third-party API integrations locally without touching production services, leaking real keys, sending real messages, or charging real cards.

Start here:
1. Read #rules
2. Check #quickstart
3. Use #support if you get stuck
4. Use #feature-requests to suggest what we should build next
```

### `#rules`

Purpose: правила сервера.

Channel type: text, read-only.

Pinned message:

```text
GhostAPI Discord Rules

1. Be useful and respectful.
2. No spam, scams, or low-effort promotion.
3. Do not post real API keys, tokens, secrets, private logs, or customer data.
4. Mask secrets before sharing screenshots or logs.
5. Use support channels for support, feature channels for ideas, and bug channels for bugs.
6. Do not ask people to test against production APIs unless they explicitly choose to.
7. Keep discussions technical, clear, and constructive.
```

### `#quickstart`

Purpose: быстрый старт для новых пользователей.

Channel type: text, read-only.

Pinned message:

```text
Quickstart

Run GhostAPI:

```bash
npx @yiaany/ghostapi start --open
```

Generate agent/MCP setup:

```bash
npx @yiaany/ghostapi setup --write
```

Start MCP manually:

```bash
npx @yiaany/ghostapi mcp
```

Dashboard:

```text
http://127.0.0.1:8080/dashboard
```

Point local SDKs and HTTP clients to:

```text
http://127.0.0.1:8080
```

If you need help, post in #support.
```

### `#roles`

Purpose: пользователи выбирают роли.

Channel type: text, can use reaction roles / onboarding.

Message:

```text
Choose what you use GhostAPI with:

MCP User
Stripe User
OpenAI User
GitHub User
Discord User
Twilio User
Resend User
Generic REST User

Choose notifications:

Release Updates
Beta Features
Help Wanted
```

## 2. ANNOUNCEMENTS

### `#announcements`

Purpose: важные анонсы.

Channel type: announcement channel, read-only.

Post format:

```text
GhostAPI vX.X.X is out

What changed:
- ...
- ...
- ...

Install/update:

```bash
npm install -g @yiaany/ghostapi
```

Run:

```bash
npx @yiaany/ghostapi start --open
```

Feedback: #feedback
Issues: #bug-reports
```

### `#changelog`

Purpose: короткий changelog по версиям.

Channel type: text, read-only.

Post format:

```text
v0.1.2

Added:
- deterministic provider-shaped mocks without LLM keys
- OpenCode MCP config generation

Fixed:
- setup --write now creates .opencode/opencode.json
- doctor no longer fails when LLM key is missing
```

### `#roadmap`

Purpose: публичный roadmap.

Channel type: text, read-only or forum.

Sections:

```text
Now
- Improve MCP setup reliability
- Better provider-shaped mocks
- Demo examples for Stripe/OpenAI/GitHub

Next
- Docker/CI mode
- More scenario presets
- Better replay UX
- More provider adapters

Later
- Team workflows
- Shared scenarios
- Cloud sync optional layer
```

## 3. SUPPORT

### `#support`

Purpose: общий support.

Channel type: forum channel recommended.

Forum tags:

```text
install
mcp
dashboard
stripe
openai
github
windows
macos
linux
resolved
```

Post template:

```text
What are you trying to do?

Command you ran:

```bash

```

What happened?

Expected behavior:

OS:
Node version:
GhostAPI version:

Please remove API keys, tokens, and private data before posting logs.
```

Pinned message:

```text
Need help?

Please include:
- command you ran
- error output
- OS
- Node version
- GhostAPI version
- whether you are using MCP, dashboard, or CLI

Never post real API keys or secrets.
```

### `#mcp-support`

Purpose: отдельный канал для MCP/OpenCode/Cursor/Cline setup.

Channel type: forum or text.

Pinned message:

```text
MCP Setup Help

Generate setup files:

```bash
npx @yiaany/ghostapi setup --write
```

OpenCode config should exist here:

```text
.opencode/opencode.json
```

Expected OpenCode MCP config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ghostapi": {
      "type": "local",
      "command": ["npx", "-y", "@yiaany/ghostapi", "mcp"],
      "enabled": true
    }
  }
}
```

Important: restart your agent after changing MCP config.
```

### `#install-help`

Purpose: npm/node/windows/mac install issues.

Pinned message:

```text
Install Checks

Check Node:

```bash
node -v
```

GhostAPI requires Node 20+.

Run:

```bash
npx @yiaany/ghostapi --help
```

If npx cache is weird:

```bash
npm cache verify
```
```

## 4. FEEDBACK AND PRODUCT

### `#feature-requests`

Purpose: предложения новых функций.

Channel type: forum channel recommended.

Forum tags:

```text
mcp
provider
dashboard
scenarios
chaos-mode
tests
docs
cli
high-impact
under-review
planned
shipped
declined
```

Post template:

```text
Feature title:

Problem:
What is hard, unsafe, slow, or annoying today?

Proposed solution:
What should GhostAPI do?

Example workflow:
1.
2.
3.

Which provider or agent does this affect?

How important is this?
- nice to have
- important
- blocking
```

Pinned message:

```text
Suggest features here.

Good feature requests explain:
- the problem
- the workflow
- what provider/agent is affected
- what a good solution would feel like

Examples:
- Add Shopify provider-shaped responses
- Save dashboard traffic as a reusable scenario
- Better OpenCode MCP setup validation
- Generate tests from traffic automatically
```

### `#feedback`

Purpose: общий feedback, UX, positioning, docs.

Channel type: text or forum.

Pinned message:

```text
Tell us what feels confusing, slow, broken, or missing.

Useful feedback:
- I expected X but GhostAPI did Y
- The dashboard confused me because...
- MCP setup was hard because...
- The docs should explain...
```

### `#provider-requests`

Purpose: запросы новых провайдеров.

Channel type: forum.

Tags:

```text
payments
email
messaging
ai
devtools
crm
auth
storage
high-demand
planned
shipped
```

Template:

```text
Provider name:

Provider docs URL:

Main endpoints you need:

Success response example:

Failure response example:

Why do you need this provider locally?
```

## 5. BUGS

### `#bug-reports`

Purpose: баги.

Channel type: forum channel.

Tags:

```text
cli
mcp
dashboard
proxy
provider
windows
macos
linux
needs-info
confirmed
fixed
```

Bug template:

```text
Bug summary:

Steps to reproduce:
1.
2.
3.

Expected result:

Actual result:

Command output:

```bash

```

Environment:
- OS:
- Node version:
- GhostAPI version:
- Agent/client:

Did this touch a real provider? yes/no

Remove all secrets before posting.
```

### `#known-issues`

Purpose: известные проблемы и обходные пути.

Channel type: read-only.

Example post:

```text
OpenCode does not see GhostAPI MCP tools

Fix:
1. Run:

```bash
npx @yiaany/ghostapi setup --write
```

2. Confirm:

```text
.opencode/opencode.json
```

3. Fully restart OpenCode.
```

## 6. DEVELOPERS

### `#showcase`

Purpose: пользователи показывают demos, workflows, screenshots.

Pinned message:

```text
Show what you built with GhostAPI.

Good posts include:
- what agent you used
- what provider you mocked
- what failure/scenario you tested
- screenshot or short video
```

### `#examples`

Purpose: готовые snippets/examples.

Pinned message:

```text
Share small examples here:
- Stripe payment failure
- OpenAI local completion
- GitHub issue creation
- Discord message send
- custom REST scenario
```

### `#agent-workflows`

Purpose: обсуждение Cursor/OpenCode/Cline/Aider/Codex workflows.

Pinned message:

```text
Discuss AI coding agent workflows here.

Useful topics:
- MCP prompts
- safe API testing loops
- generated tests
- scenario replay
- agent setup configs
```

### `#dev-chat`

Purpose: общий technical chat.

Keep it lightweight.

## 7. COMMUNITY

### `#general`

Purpose: общее общение.

Pinned message:

```text
General GhostAPI chat.

For support, use #support.
For bugs, use #bug-reports.
For feature ideas, use #feature-requests.
```

### `#introductions`

Purpose: пользователи представляются.

Template:

```text
Who are you?

What are you building?

Which agents/tools do you use?

Which APIs do you want to test locally?
```

### `#off-topic`

Purpose: оффтоп.

Keep optional.

## Suggested Channel Order

```text
START HERE
  #welcome
  #rules
  #quickstart
  #roles

ANNOUNCEMENTS
  #announcements
  #changelog
  #roadmap

SUPPORT
  #support
  #mcp-support
  #install-help

FEEDBACK AND PRODUCT
  #feature-requests
  #feedback
  #provider-requests

BUGS
  #bug-reports
  #known-issues

DEVELOPERS
  #showcase
  #examples
  #agent-workflows
  #dev-chat

COMMUNITY
  #general
  #introductions
  #off-topic
```

## Discord Onboarding Questions

Use Discord onboarding if available.

Question 1:

```text
What are you using GhostAPI for?
```

Answers:

```text
AI coding agents
Stripe/payment integrations
OpenAI/LLM integrations
MCP workflows
Generic REST APIs
Just exploring
```

Question 2:

```text
Which tool are you using?
```

Answers:

```text
OpenCode
Cursor
Claude
Cline
Aider
Codex
Gemini CLI
Other
```

Question 3:

```text
What updates do you want?
```

Answers:

```text
Release Updates
Beta Features
Help Wanted
```

## Moderation Settings

Recommended Discord safety settings:

- verification level: medium;
- scan media from all members;
- block suspected spam content;
- require verified email;
- disable `@everyone` for normal users;
- only Team/Moderator can post in announcements;
- create slowmode in `#support` if spam starts;
- require threads/forum posts for bug reports and feature requests.

## Bots

Recommended bots:

```text
Sapphire or Carl-bot: reaction roles / moderation
GitHub bot: GitHub issue/release updates
Statbot: community analytics
```

Optional:

```text
Sentry bot if you later connect production errors
```

## First Announcement Post

```text
Welcome to GhostAPI Discord.

GhostAPI is the local internet for AI coding agents.

Start GhostAPI:

```bash
npx @yiaany/ghostapi start --open
```

Generate MCP setup:

```bash
npx @yiaany/ghostapi setup --write
```

Use #support if you need help.
Use #feature-requests to tell us what to build next.
Use #bug-reports if something breaks.
```

## First Feature Request Prompt

Pin this in `#feature-requests`:

```text
What should GhostAPI support next?

Examples:
- More provider-shaped mocks
- Better dashboard replay
- Docker/CI mode
- More MCP tools
- Scenario sharing
- Test generation improvements
- Provider support for Shopify, Supabase, Clerk, PayPal, Slack, Notion, Linear, etc.

Post your feature request using the template.
```

## Support Workflow

When someone asks for help:

1. Ask for command output.
2. Ask for OS and Node version.
3. Ask if they used `setup --write`.
4. Ask if they restarted their agent after MCP setup.
5. Ask them to remove secrets from logs.
6. If solved, tag thread as `resolved`.
7. If it is a product bug, ask them to open a `#bug-reports` post.

## Feature Request Workflow

When someone suggests a feature:

1. Add tag `under-review`.
2. Ask for real workflow/use case.
3. Ask which provider/agent is affected.
4. If useful, move to `planned`.
5. When shipped, post in `#changelog` and tag `shipped`.

## Minimum Viable Launch Setup

If you want to launch fast, create only these first:

```text
#welcome
#rules
#quickstart
#announcements
#support
#mcp-support
#feature-requests
#bug-reports
#general
```

Add the rest after first users arrive.
