# GhostAPI Usage Guide

## Start The Local API

```bash
npx @yiaany/ghostapi start --open
```

GhostAPI listens on:

```text
http://127.0.0.1:8080
```

Dashboard:

```text
http://127.0.0.1:8080/dashboard
```

Loopback is the convenient default. A non-loopback bind requires `GHOSTAPI_AUTH_TOKEN` with at least 24 characters:

```bash
GHOSTAPI_AUTH_TOKEN="replace-with-a-long-random-token" ghostapi start --host 0.0.0.0 --https --open
```

Remote access protects dashboard/control routes with the token, but the token does not encrypt traffic. Use HTTPS or a secure tunnel. Provider simulation routes are not authenticated and GhostAPI does not provide network isolation.

## Egress Diagnosis

Before relying on a future `ghostapi run` backend, inspect the host-specific boundary that GhostAPI can honestly provide:

```bash
ghostapi doctor --egress
ghostapi doctor --egress --json
```

The current release always reports `NOT ISOLATED`: it provides local HTTP proxy guidance, not process containment. The JSON output is stable for CI/tooling and identifies the available platform primitives, required setup, and remaining bypasses without probing production network access. See [`docs/security/egress-threat-model.md`](security/egress-threat-model.md) for the security model.

## Send A Local Request

```bash
curl -X POST http://127.0.0.1:8080/v1/customers \
  -H "content-type: application/json" \
  -H "authorization: Bearer stripe_test_ghostapi" \
  -d '{"email":"ada@example.com","name":"Ada Lovelace"}'
```

## Stripe SDK

```ts
import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "stripe_test_ghostapi", {
  host: process.env.GHOSTAPI_HOST ?? "127.0.0.1",
  port: Number(process.env.GHOSTAPI_PORT ?? "8080"),
  protocol: process.env.GHOSTAPI_PROTOCOL ?? "http"
});
```

## OpenAI SDK

```ts
import OpenAI from "openai";

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "sk-ghostapi",
  baseURL: process.env.GHOSTAPI_OPENAI_BASE_URL ?? "http://127.0.0.1:8080/v1"
});
```

The `OPENAI_API_KEY` above belongs to the application being pointed at the local GhostAPI endpoint; use a fake local value. It does not enable GhostAPI's own external LLM access.

## Optional External LLM Generation

External generation is disabled by default, even when `OPENAI_API_KEY` exists in the environment. To opt in explicitly, provide both the capability flag and the GhostAPI-specific key:

```bash
GHOSTAPI_LLM_API_KEY="..." ghostapi start --allow-external-llm
```

The equivalent environment flag is `GHOSTAPI_ALLOW_EXTERNAL_LLM=true`. `--offline` overrides external access.

When external generation is enabled on a non-loopback bind, proxy requests also require `Authorization: Bearer <GHOSTAPI_AUTH_TOKEN>` or `X-GhostAPI-Token`. This prevents unauthenticated clients from consuming the configured external LLM account.

## Local Data And Retention

Runtime files default to `.ghostapi/`. Set `GHOSTAPI_DATA_DIR` to isolate tests or multiple instances. Persisted events use a 5 MiB active log plus two rotated archives, and each persisted event is capped at 256 KiB. Local JSON mutations use inter-process lock files and atomic replacement on the local filesystem.

Generated Vitest files read `GHOSTAPI_BASE_URL`, falling back to `http://127.0.0.1:8080`, so CI can use an ephemeral or custom port.

## Provider Capabilities

Inspect built-in providers and their implementation mode from the CLI:

```bash
ghostapi providers list
ghostapi providers inspect resend
```

The dashboard reads the same versioned capability manifests from:

```text
GET http://127.0.0.1:8080/api/providers
```

Resend is the first provider migrated to the `ProviderPack` contract. Its deterministic responses include `x-ghostapi-provider-pack` and `x-ghostapi-api-version`. Select the current GhostAPI compatibility version explicitly with `x-ghostapi-api-version: v1`. Other providers remain available through legacy adapters while they are migrated one at a time. Generic REST remains the fallback.

## Failure Scenarios

Use MCP or the dashboard to force deterministic responses such as Stripe card declines, rate limits, upstream errors, and latency.

The goal is to make failure handling repeatable instead of relying on live provider behavior.
