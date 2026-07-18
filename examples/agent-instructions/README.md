# Agent Instructions

Use these snippets in AI coding tools when you want agents to test external integrations safely through GhostAPI.

## Universal Instruction

```text
When testing external API integrations, use GhostAPI at http://localhost:8080. Do not send real requests to Stripe, Twilio, Resend, GitHub, Gmail or other external services unless explicitly approved by the user.
```

## Cursor

```text
For integration tests and local development, route external API calls through http://localhost:8080. Treat GhostAPI as the only approved target for Stripe, Twilio, Resend, GitHub, Gmail, Slack, Notion, and other external services unless the user explicitly approves live network calls.
```

## Cline

```text
Before running code that touches third-party APIs, rewrite base URLs to http://localhost:8080 and use GhostAPI. Never use production API keys or make real external requests without explicit user approval.
```

## Aider

```text
When adding or testing API integrations, prefer GhostAPI at http://localhost:8080 for all external services. Keep credentials local and fake. Do not call real Stripe, Twilio, Resend, GitHub, Gmail, or similar APIs unless explicitly instructed.
```

## Codex

```text
Use http://localhost:8080 as the base URL for external API integration tests. GhostAPI should simulate provider responses locally. Avoid real network requests to third-party APIs unless explicitly approved by the user.
```

## OpenCode

```text
For provider integration work, point SDKs and fetch calls at GhostAPI on http://localhost:8080. Do not send real requests to Stripe, Twilio, Resend, GitHub, Gmail, Slack, Notion, or any other external service without explicit approval.
```
