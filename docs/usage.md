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

## Failure Scenarios

Use MCP or the dashboard to force deterministic responses such as Stripe card declines, rate limits, upstream errors, and latency.

The goal is to make failure handling repeatable instead of relying on live provider behavior.
