# GhostAPI Usage Guide

## First Ten Minutes

Use these commands in a fresh project. They do not require production credentials:

```bash
npx @yiaany/ghostapi init
npx @yiaany/ghostapi doctor
npx @yiaany/ghostapi run -- npm test
```

`init` writes `.ghostapi/config.json`, `ghostapi.policy.yaml`, MCP snippets, and agent instructions without overwriting existing files. On Linux, `run` performs a fail-closed namespace preflight before launching the target. On Windows and macOS, `run` is unsupported/experimental and fails closed; use `start --open` for local provider simulation and run enforced CI on Linux.

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
ghostapi doctor --json
```

The diagnostic is stable for CI/tooling and identifies Node version, data-directory write permission, port availability, TLS bypass settings, config problems, platform primitives, required setup, and remaining bypasses without probing production network access. It is not proof that a run succeeded. See [`docs/security/egress-threat-model.md`](security/egress-threat-model.md) for the security model.

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

## Agent Evals

Use `ghostapi eval` to score an agent workflow against deterministic GhostAPI evidence:

```bash
ghostapi eval --template retry-after --evidence .ghostapi/reports/latest.json --ci
ghostapi eval --spec examples/evals/retry-after.eval.json --evidence .ghostapi/reports/latest.json --json
```

Without `--evidence`, the eval command launches `task.command` through the existing `ghostapi run` boundary and then generates evidence for that run. It does not execute an unknown command directly. Specs that declare `injectedFailures` currently require pre-generated evidence: GhostAPI rejects execution rather than pretending those failures were applied. On unsupported hosts, `ghostapi run` still fails closed instead of falling back to a proxy-only mode.

Eval specs are local JSON data only. Schema v1 describes `syntheticWorld`, `task.command`, `injectedFailures`, deterministic `expectations`, `forbidden` actions, `limits`, and a points `rubric`. Unknown fields, oversized specs, symlinks, path traversal, enabled LLM judge settings, duplicate rubric references, and incomplete point totals are rejected. Built-in templates cover retry honoring `Retry-After`, duplicate payment prevention, webhook signature validation, no secret in logs, timeout recovery, and no production bypass.

Core security score uses facts from sanitized evidence only. LLM-as-judge is optional future commentary and is never part of the core score. Forbidden actions such as production egress or secret leakage override cosmetic success and force the core score to `0`. A zero production-egress score requires completed Linux namespace run evidence; a retry score requires a retryable response followed by a matching later request. Eval reports include a stable logical hash, evidence hash/link, component-level reasons, repeatability notes, and no raw secrets.

## Stateful Synthetic Worlds

Create a portable, deterministic local world for multi-provider integration workflows:

```bash
ghostapi world create --id subscription-recovery --seed demo-seed
ghostapi world inspect subscription-recovery
ghostapi world reset subscription-recovery
ghostapi world fork subscription-recovery --id subscription-recovery-investigation
```

Schema-v1 worlds live under `.ghostapi/worlds/<id>.world.json`. A manifest defines one canonical synthetic persona and organization, an UTC clock, relationships, provider accounts/resources, and projections for Stripe, GitHub, email, and generic REST. A fixed `id`, `title`, and `seed` always generates the same initial manifest and baseline. Use non-secret, non-PII labels and seeds. A scenario/eval can pin this deterministic input with:

```json
{
  "syntheticWorld": {
    "world": { "id": "subscription-recovery", "version": "1.0.0", "seed": "demo-seed" },
    "providers": ["stripe", "github", "resend", "generic"],
    "scenarios": ["stripe-subscription-payment-failed"]
  }
}
```

The included [`examples/worlds/subscription-recovery.mjs`](../examples/worlds/subscription-recovery.mjs) models an atomic recovery flow: create a synthetic Stripe customer, put its subscription into `past_due`, record a generic REST payment failure, send a synthetic `ghostapi.invalid` email, and open a GitHub recovery issue. Every projected record references the same canonical identities and subscription ID. The workflow returns a receipt and is idempotent by action ID.

World transitions use one local file lock and same-directory atomic replacement. They are strongly consistent only for processes using the same world file on one local filesystem; GhostAPI does not claim distributed coordination, cloud tenancy, provider parity, or external delivery. Worlds are data only, capped at 512 KiB and 100 receipts, reject symlink files, secret-shaped values/fields, and non-`ghostapi.invalid` email addresses. `reset` restores the original baseline; `fork` snapshots the source's current state with lineage and then evolves independently.

## Synthetic Action Gateway

`ghostapi action` is the local foundation for one typed action contract across simulation, evidence, approvals, and a future execution gateway. In this release, its only adapter is `ghostapi-synthetic`; it executes `synthetic.subscription_failure` against an existing local synthetic world. It has no production provider account, credential, HTTP client, shell/tool execution path, message delivery, payment, deployment, or other external side effect.

An action envelope is schema-v1 JSON containing a stable `actionId`, `idempotencyKey`, agent/workload identity, project/environment, provider/operation/resource, normalized arguments, expected effects, risk/reversibility classification, policy/evidence references, expiry, and nonce. The complete normalized envelope is canonicalized with sorted object keys and SHA-256 hashed. Approval is its own schema-v1 object containing the exact `actionHash`, named independent approver, issue/expiry timestamps, and nonce; a boolean approval is not accepted.

Use the public API to construct the exact action and approval hash, then keep the JSON as reviewed artifacts:

```ts
import { actionHash, createLocalActionGateway } from "@yiaany/ghostapi";

const action = {
  schemaVersion: 1,
  kind: "ghostapi.action",
  actionId: "recover-subscription-001",
  idempotencyKey: "recover-subscription-001",
  actor: { id: "billing-agent", workloadId: "recovery-worker", type: "agent" },
  project: { id: "checkout", environment: "synthetic" },
  provider: "ghostapi-synthetic",
  operation: "synthetic.subscription_failure",
  resource: { type: "synthetic-world", id: "subscription-recovery" },
  arguments: { worldId: "subscription-recovery" },
  expectedSideEffects: [
    "stripe.subscription.past_due",
    "email.subscription_payment_failed",
    "github.recovery_issue",
    "generic_rest.payment_failed"
  ],
  riskClass: "write",
  reversibility: "none",
  policy: { version: 1, hash: "<SHA-256 of reviewed policy source>" },
  evidence: { hash: "<SHA-256 evidence reference>" },
  expiresAt: "2030-01-01T00:00:00.000Z",
  nonce: "review-001"
} as const;

const approval = {
  schemaVersion: 1,
  kind: "ghostapi.action-approval",
  approvalId: "approval-recover-subscription-001",
  actionHash: actionHash(action),
  approvedBy: "human-reviewer",
  approvedAt: "2026-08-13T00:00:00.000Z",
  expiresAt: "2030-01-01T00:00:00.000Z",
  nonce: "approval-review-001"
} as const;

const gateway = createLocalActionGateway();
await gateway.submit(action, approval, { version: 1, hash: action.policy.hash, allowed: true });
const receipt = await gateway.execute(action, { actorId: "billing-agent", workloadId: "recovery-worker" }, { version: 1, hash: action.policy.hash, allowed: true });
```

CLI commands accept only regular non-symlink local JSON under the project root or `GHOSTAPI_DATA_DIR` and re-load the supplied policy at submit and execution:

```bash
ghostapi action submit --action action.json --approval approval.json --policy ghostapi.policy.yaml
ghostapi action inspect recover-subscription-001 --json
ghostapi action execute --action action.json --policy ghostapi.policy.yaml --actor billing-agent --workload recovery-worker --json
```

Before the synthetic side effect, the gateway checks exact action hash, independent approval, action/approval expiry, current policy version/hash, execution actor/workload identity, adapter operation support, and idempotency state. Receipts progress through `requested`, `attempted`, `committed`, `verified`, or `failed`; an attempted action is reconciled before any re-execution. Unknown provider outcomes and verification failures are explicitly not safe to retry. Unsupported operations or compensation fail visibly. The local store is bounded to 128 KiB per record and 20 receipts, uses per-action locks and atomic writes, and rejects symlink records.

Policy schema v1 does not yet contain action-level authorization rules. This release verifies the reviewed policy reference at execution to prevent stale-policy use; it does not claim that a generic policy authorizes a production action. Read [`docs/security/action-gateway-threat-model.md`](security/action-gateway-threat-model.md) before extending the adapter boundary.

## Credential Broker And Workload Identity

The public `CredentialBroker` API is a local foundation for keeping upstream provider secrets outside an AI agent's context. It has no CLI, MCP tool, HTTP endpoint, provider SDK, environment-secret loader, or API that returns a provider secret. A grant is always audience-bound to `ghostapi-server`, so the agent process cannot receive it as an environment variable, argument, stdin value, log, report, or response.

The broker stores only credential metadata, scoped grant metadata, and action-linked execution receipts in `.ghostapi/credential-broker.json`. Secret material remains behind an injected vault interface. This repository intentionally ships only a test in-memory vault and test executor for automated integration tests; neither has network or provider capability. Production use requires an existing reviewed vault/KMS abstraction and a separately reviewed server-side provider executor. Do not implement homemade reversible encryption or place secret material in `.env`, fixtures, scenario bundles, approval records, or MCP responses.

Workload identities distinguish `agent_run`, `ci_job`, and `production_service` and bind a tenant, project, environment, workload, subject, run, issue time, and expiry. Before each server-side execution the broker rechecks workload identity, credential/grant revocation and expiry, tenant/project/environment, provider, scope, server-only audience, credential version after rotation, and exact action ID/hash/verified receipt reference. Standard grants last at most 15 minutes. Break-glass is disabled unless an injected independent human-controlled authorizer validates an exact-action approval, and its grants last at most 5 minutes.

Rotation changes the opaque vault reference, increments the credential version, and revokes active grants without touching local simulation state. Revocation blocks all new execution before vault access. `listOrphanedCredentials()` reports active credentials whose configured owner workload is no longer active; it does not delete or transfer them automatically. Read [`docs/security/credential-broker-threat-model.md`](security/credential-broker-threat-model.md) before implementing any vault, identity, approval, or provider adapter.

## Local Approval Inbox

`createLocalApprovalInbox()` is a typed local API for a human approval workflow over the existing synthetic action gateway. It has no CLI, hosted UI, Slack/email integration, bearer approval link, external notification, real credential, or production provider path. An injected approver verifier authenticates local approver objects; messages and LLM text are never approval authority.

Requests are generated from an exact action envelope and display the intent, target, normalized argument diff, expected side effects, reversibility, amount impact, policy reason, evidence hash, and successful synthetic preflight result. The risk taxonomy includes `read`, `create`, `update`, `communicate`, `money_movement`, `delete`, `permission_change`, and `deployment`; risk is derived by GhostAPI, not supplied by an agent. The current synthetic subscription workflow is an `update` action only.

Policies can restrict environment, actor, resource, amount, confidence, and action velocity. Actions requiring two-person review require distinct approver independence keys. Approval artifacts are exact-action-hash-bound, expiring, single-use, and rechecked along with the current policy before the action gateway is called. Reject, revoke, timeout, expiry, changed arguments, changed identity, and policy drift all fail closed. Read [`docs/security/approval-inbox-threat-model.md`](security/approval-inbox-threat-model.md) before connecting any future identity, notification, or provider execution system.

## Team Control-Plane Prototype

The [design-partner validation kit](design-partners/README.md) records no independently verifiable interview, CI, bug-caught, LOI, or paid-pilot evidence in this repository, so the cloud/enterprise gate remains unmet. The included prototype remains a local typed library, not a hosted account system or web UI. It models organizations, members/roles, projects, environments, versioned scenario metadata, sanitized CI evidence summaries, distributed policy versions, short-lived revocable tokens, audit metadata, migrations, and bounded retention. The separate hosted pilot skeleton and its explicit deployment limits are documented in [`docs/hosted-pilot.md`](hosted-pilot.md).

Local runtime behavior is unchanged and does not require login. Cloud sync is not implemented. The prototype never uploads raw traffic, code, secrets, request bodies, or provider credentials; evidence is accepted only after GhostAPI schema/hash validation and stored as a restricted summary. Read [`docs/team-control-plane.md`](team-control-plane.md) for the tenant model, API, storage limitations, incident response, and design-partner onboarding workflow.

## Optional Local Product Telemetry

GhostAPI has no telemetry by default. `ghostapi telemetry enable` stores only four local aggregate counters and up to eight ISO week labels in `.ghostapi/product-telemetry.json`; it has no network transport and never records source code, traffic, commands, provider names, repository identity, credentials, or secrets. Inspect the aggregate with `ghostapi telemetry status` or `ghostapi telemetry export --json`. `ghostapi telemetry disable` deletes it. See [`docs/design-partners/telemetry-plan.md`](design-partners/telemetry-plan.md) for the event schema and retention limits.

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

## Contract Import And Drift

GhostAPI imports a deliberately small, local-only OpenAPI subset: JSON OpenAPI `3.0.x`, non-parameterized relative paths, standard HTTP methods, JSON request/response bodies, object/array/scalar schemas, `required`, and scalar `enum` values. It does not support YAML, OpenAPI 3.1, Swagger 2.0, `$ref` (including local refs), remote URLs, callbacks, links, composition, path/query/header parameter schemas, headers, security schemes, servers, or executable extensions. Unsupported input fails with an actionable error; the importer never opens a network connection.

```bash
ghostapi contract import-openapi --input openapi.json --out .ghostapi/contracts/orders.contract.json
ghostapi contract import-har \
  --input sandbox.har \
  --allow-sandbox-host api.sandbox.example \
  --contract-out .ghostapi/contracts/sandbox.contract.json \
  --approve
```

HAR import first passes through the exact same bounded sanitizer used by `ghostapi record`; it writes the sanitized scenario bundle and derives a contract only from that sanitized data. Contract input is limited to 1 MiB, output to 512 KiB, OpenAPI to 200 paths/400 operations, schemas to depth 20, and object schemas to 100 properties. ZIP and gzip archives are rejected before parsing or decompression; extract one reviewed JSON file first.

Compare contracts in CI without any live provider request:

```bash
ghostapi contract diff \
  --baseline .ghostapi/contracts/base.contract.json \
  --candidate .ghostapi/contracts/head.contract.json \
  --policy ghostapi.policy.yaml \
  --ci

ghostapi evidence generate \
  --policy ghostapi.policy.yaml \
  --contract-baseline .ghostapi/contracts/base.contract.json \
  --contract-candidate .ghostapi/contracts/head.contract.json \
  --ci
```

The diff deterministically reports added/removed endpoints, request required-field changes, enum/type changes, response status/schema changes, and provider-pack capability drift. Removed endpoints, removed response fields/statuses, narrowed enums, type changes, and lost pack capabilities are breaking. Added endpoints and optional request fields are non-breaking. Added response enum/status/fields and changed schema presence are `uncertain`, because client tolerance cannot be inferred. `reports.maxBreakingContractChanges` defaults to `0` when omitted and can be set explicitly in policy. Evidence artifacts include breaking/non-breaking/uncertain totals and fail CI according to the policy threshold.

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

## Starter Examples

- Stripe checkout and billing: [`examples/stripe-node`](../examples/stripe-node)
- OpenAI streaming/tool call: [`examples/openai-streaming`](../examples/openai-streaming)
- CI policy failure: [`examples/ci-smoke`](../examples/ci-smoke)
- Record/replay: [`examples/record-replay`](../examples/record-replay)
- Agent eval: [`examples/evals`](../examples/evals)

## Configuration

Local runtime config lives in `.ghostapi/config.json`. Environment variables override it for the current process: `GHOSTAPI_HOST`, `GHOSTAPI_PORT`, `GHOSTAPI_MODEL`, `GHOSTAPI_OFFLINE`, `GHOSTAPI_HTTPS`, `GHOSTAPI_ALLOW_EXTERNAL_LLM`, `GHOSTAPI_LLM_API_KEY`, `GHOSTAPI_AUTH_TOKEN`, and `GHOSTAPI_DATA_DIR`.

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

## Uninstall And Cleanup

Remove a global install with:

```bash
npm uninstall -g @yiaany/ghostapi
```

Remove local runtime state with `rm -rf .ghostapi` on POSIX shells, or delete the `.ghostapi` directory with PowerShell/Explorer on Windows. If `init` created setup files, remove `ghostapi.policy.yaml`, generated MCP snippets, and generated agent instructions only after reviewing local edits.

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

Use MCP or the dashboard to force deterministic responses such as Stripe card declines, rate limits, upstream errors, and latency. `set_api_behavior` supports a bounded optional `delayMs` value (0-10,000) for a specific method/path, allowing a repeatable client-timeout test without any provider call.

The goal is to make failure handling repeatable instead of relying on live provider behavior.
