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

Before relying on `ghostapi run`, inspect the host-specific boundary that GhostAPI can honestly provide:

```bash
ghostapi doctor --egress
ghostapi doctor --egress --json
```

The diagnostic is stable for CI/tooling and identifies platform primitives, required setup, and remaining bypasses without probing production network access. It is not proof that a run succeeded. See [`docs/security/egress-threat-model.md`](security/egress-threat-model.md) for the security model.

## Run With Linux Egress Enforcement

On Linux hosts where unprivileged user, mount, network and PID namespaces are available, run a command with a loopback-only network namespace:

```bash
ghostapi run -- npm test
```

The target and all ordinary descendants have no external route, DNS path or non-loopback IP interface. GhostAPI starts inside the same namespace at `http://127.0.0.1:8080`; the target receives `GHOSTAPI_BASE_URL`, `GHOSTAPI_HOST`, `GHOSTAPI_PORT`, `GHOSTAPI_PROTOCOL`, and `GHOSTAPI_OPENAI_BASE_URL`.

`ghostapi run` fails closed on Windows, macOS, hosts without a successful namespace preflight, and any external `--allow-host` value. There is no proxy-only fallback. The current backend does not transparently intercept provider TLS hostnames or provide individual audit records for kernel-denied socket attempts. Do not mount or expose same-user container-control UNIX sockets to untrusted code; this is not a hostile-code filesystem sandbox.

Each run writes sanitized lifecycle evidence under `.ghostapi/runs/<run-id>/run.json`. The command, argument values and environment secrets are not persisted there; allowed GhostAPI request traffic remains in the run's isolated GhostAPI event log.

## Evidence Reports

Turn run lifecycle evidence, persisted traffic events and an optional policy into a canonical JSON artifact:

```bash
ghostapi evidence generate --policy ghostapi.policy.yaml --ci
ghostapi evidence view .ghostapi/reports/latest.json
ghostapi evidence compare .ghostapi/reports/base.json .ghostapi/reports/head.json
```

The report includes run identity, timestamps, GhostAPI version, enforcement capability, policy hash, covered providers/scenarios, allowed GhostAPI attempts, secret categories, retry/failure counts, findings and incomplete-evidence warnings. It intentionally does not include request authorization, cookies, raw body secrets, command arguments or raw policy content.

Artifacts use schema version `1`, a stable logical hash over sorted JSON keys, a 512 KiB file limit and local retention of the latest 20 generated reports under `.ghostapi/reports/`. `ghostapi evidence view` rejects corrupted artifacts whose logical hash no longer matches their contents. `--ci` exits non-zero when fail findings are present.

When using `ghostapi run`, pass its exact `.ghostapi/runs/<run-id>/run.json` to `evidence generate --run`. GhostAPI then reads the isolated runtime event log for that run, rather than unrelated host/workspace events. See [`docs/github-actions.md`](github-actions.md) for the pinned GitHub Actions workflow and [`docs/ci.md`](ci.md) for generic CI integration.

## Policy As Code

Use a strict local `ghostapi.policy.yaml` to make network, credential, scenario, enforcement and report decisions deterministic:

```bash
ghostapi policy validate
ghostapi policy explain network api.stripe.com --provider stripe
ghostapi policy explain stripe-payment-intent-card-declined
ghostapi run --policy ghostapi.policy.yaml -- npm test
```

See [`docs/policy.md`](policy.md) and the safe [`examples/policy/ghostapi.policy.yaml`](../examples/policy/ghostapi.policy.yaml). The policy language has no remote includes, interpolation, or executable expressions.

## Record And Replay Sandbox Traffic

Record only an explicit, reviewed sandbox host. GhostAPI accepts a bounded JSON capture with either an `interactions` array or HAR `log.entries`; it does not use a recording proxy and never stores a raw temporary capture:

```bash
ghostapi record \
  --input stripe-sandbox.har \
  --allow-sandbox-host api.stripe.com \
  --title "Checkout retry" \
  --approve
```

`api.stripe.com` is accepted only when captured requests carry a Stripe test/restricted-test key. Other hosts must both be explicitly allowlisted and look sandbox/test-like. HTTPS is required. Production-looking, unknown, direct-IP, HTTP, and wildcard hosts fail closed.

Before writing the portable schema-v1 bundle, GhostAPI structurally removes authorization, cookies, secret-shaped fields and known keys; redacts emails, phones and address fields by default; turns known unstable IDs/timestamps into deterministic variables; drops multipart/binary bodies; and blocks external redirect targets. It prints a summary and requires `--approve` whenever any potentially sensitive category was found. `--pii none` or a narrower comma-separated list is available only for a deliberate, reviewed capture; it does not make secret masking optional.

Replay is entirely offline and sequence-strict. It accepts a JSON request array (or `{ "requests": [...] }`) and never scans ahead for a later matching interaction:

```bash
ghostapi replay .ghostapi/scenarios/checkout-retry.bundle.json --requests replay-requests.json --json
```

The first matched request can bind a recorded variable; later requests and synthetic responses reuse that binding. A mismatch, missing request, extra request, ambiguous alternate order, invalid schema, symlink, oversized file, secret-bearing bundle value, or executable/unknown field fails with diagnostics. Bundle files are limited to 512 KiB, captures and replay input to 1 MiB, and bundles contain data only: no hooks, filesystem paths, commands, or executable expressions. Schema v0 uses the documented local migration to v1 and is marked `legacy-bundle` for review; unsupported versions fail closed.

PII detection is intentionally heuristic, not a guarantee of anonymization. Review the summary and the saved sanitized bundle before sharing it. Do not capture production traffic.

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
