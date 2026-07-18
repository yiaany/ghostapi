# Contributing to GhostAPI

Thanks for helping improve GhostAPI. This project aims to be small, safe, local-first, and useful for developers and AI coding agents.

## Setup

Requirements:

- Node.js 20 or newer
- npm

Install dependencies:

```bash
npm install
```

Run the local development server:

```bash
npm run dev
```

Open:

```text
http://localhost:8080/dashboard
```

## Scripts

```bash
npm run typecheck
npm test
npm run build
npm run dev
```

Use these before opening a pull request:

```bash
npm run typecheck
npm test
npm run build
```

## Tests

Tests are written with Vitest and must stay local-only. Do not add tests that call real Stripe, Twilio, Resend, GitHub, OpenAI, or any other external API.

Current test areas include:

- Secret masking
- Provider detection
- Cache key stability
- State save/read/list/delete
- Provider error formatting
- Prompt construction and JSON repair
- Proxy flow integration
- Dashboard/SSE event formatting

Shared fixtures live in `test/fixtures/`.

## Coding Style

- TypeScript strict mode.
- ESM modules.
- Prefer functions and simple objects over classes.
- Keep modules small and direct.
- Avoid `any`; use `unknown` and narrow values where possible.
- Add comments only where behavior is not obvious.
- Keep user-facing errors actionable.
- Do not introduce network calls to real provider APIs by default.

## Adding A Provider

GhostAPI intentionally keeps native adapters limited. For the MVP, native adapters are:

- Stripe
- Twilio
- Resend
- GitHub
- Discord
- OpenAI
- Generic fallback

Before adding a new native adapter, ask whether generic fallback plus prompt hints is enough. Native adapters should be reserved for providers where contract-specific behavior, validation, or error formatting is clearly worth maintaining.

If a native adapter is justified:

1. Add the adapter under `src/providers/`.
2. Register it in `src/providers/registry.ts`.
3. Add detection rules in `src/proxy/providerDetector.ts`.
4. Add provider-specific prompt guidance in `src/ai/prompts.ts` only if useful.
5. Add tests for detection, formatting, validation, and proxy behavior.
6. Update README provider matrix.

## Adding Prompt Hints

Most services should use generic fallback. To improve generic behavior:

1. Add or refine lightweight inference in `src/ai/genericInference.ts`.
2. Keep labels best-effort, such as `generic:shopify-like`.
3. Do not add provider-specific validation or error formats for generic services.
4. Add tests in `test/genericInference.test.ts`.
5. Update README coverage if the change affects documented behavior.

## Pull Request Checklist

- The change is scoped and explained clearly.
- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- New behavior has tests when practical.
- No real external API calls were added by default.
- Secrets are not logged, cached, sent to LLM prompts, or exposed in dashboard payloads.
- README or examples are updated when user-facing behavior changes.
