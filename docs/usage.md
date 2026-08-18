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

## Local Action Ledger And Incident Replay

`createLocalActionLedger()` is a local typed API, not a CLI or hosted audit service. It records a tenant-scoped, append-only action timeline from an existing `StoredAction` returned by the synthetic action gateway. The timeline connects intent, identity, policy decision, approval, credential-grant reference, execution attempts, provider receipts, verification/reconciliation, and compensation status.

```ts
const access = createTestLedgerAccessAuthorizer(); // Test helper only.
const tenantAudit = access.issue({
  tenantId: "tenant-a",
  principalId: "audit-service",
  permissions: ["append", "read", "export"]
});
const ledger = createLocalActionLedger({ accessAuthorizer: access.authorizer });

await ledger.recordAction(tenantAudit, await gateway.inspect("action-one"));
const timeline = await ledger.timeline(tenantAudit, "action-one");
const exported = await ledger.exportTenant(tenantAudit);
```

Every entry uses SHA-256 over canonical structured data plus the previous tenant entry hash. Verification fails if content, ordering, a chain link, head hash, or entry count changes. Export first verifies the requested tenant chain and returns only that tenant's entries. The ledger rejects raw payloads and credential/PII-shaped fields; it records hashes or safe scalar references instead.

Turn an action with a confirmed or ambiguous outcome into a local regression fixture:

```ts
const incident = await ledger.createIncidentFixture(tenantAudit, "action-one");
const result = await ledger.replayIncidentFixture(tenantAudit, incident.fixture);
```

The pipeline creates a deterministic synthetic world and one sanitized, sequence-strict local scenario bundle. It does not open a network connection, call a provider, reuse an original credential, or copy an action payload into the ledger. An ambiguous or unverified result reproduces as `409 requires_reconciliation`, never as success. Add the generated `*.fixture.json` and `*.bundle.json` to a normal Vitest/CI fixture test to make the incident a regression check.

Retention is intentionally conservative: a recorded retention value does not automatically prune the chain; local legal hold blocks deletion requests; and a deletion request is only an auditable request, not an erasure or compliance claim. See the [action-ledger and incident-replay threat model](security/action-ledger-incident-replay-threat-model.md).

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

Policies can restrict environment, actor, resource, amount, confidence, and action velocity. Actions requiring two-person review require distinct verified principals and approver independence keys. Approval artifacts are exact-action-hash-bound, expiring, single-use, and rechecked along with the current policy before the action gateway is called. Public action-gateway methods reject inbox-issued artifacts, so artifact data alone cannot bypass consumption, revoke, or inbox audit state. Reject, revoke, timeout, expiry, changed arguments, changed identity, and policy drift all fail closed. Read [`docs/security/approval-inbox-threat-model.md`](security/approval-inbox-threat-model.md) before connecting any future identity, notification, or provider execution system.

## Local Synthetic Trust Ladder

`createLocalTrustLadder()` is a data-only preparation layer for the typed synthetic action contract. It does not call the action gateway, approval inbox, credential broker, vault, provider SDK, HTTP client, or a real provider. Its only target identity is `{ provider: "ghostapi-synthetic", environment: "synthetic" }`; production/test-account identity mixing is rejected.

| Trust level | Local synthetic capability | External side effects |
| --- | --- | --- |
| `simulate` | Supported local preparation state. | Never. |
| `shadow` | Supported hash-only comparison of predicted action/context with supplied actual input context. | Never. |
| `dry-run` | Unsupported because `ghostapi-synthetic` has no provider-official dry-run semantic. It is never substituted with execution. | Never. |
| `approve` | Supported preparation state that denotes the existing approval boundary requirement. | Never. |
| `bounded-auto` | Supported preparation state with deterministic canary eligibility and predicted/actual outcome comparison evidence. | Never. |
| `trusted` | Unsupported. Local synthetic state is not production authorization. | Never. |

Promotion is owner-gated and never automatic: a verified stable owner principal must explicitly advance exactly one supported step and provide fresh evidence meeting minimum-run, required-eval, violation-rate, and error-rate policy thresholds. Canary scope is tenant/resource/percentage based and assigned from a stable SHA-256 bucket. Violations can auto-demote to `approve` or open a circuit breaker according to policy. Once a breaker is open or a configured stop condition is breached, the controller rejects further canary activity. `rollbackToApproval()` records its reason in the bounded local audit chain. The store contains hashes and bounded metadata only under `.ghostapi/trust-ladder.json`; it is not a durable production audit ledger or authorization system. Read [`docs/security/trust-ladder-threat-model.md`](security/trust-ladder-threat-model.md) before extending any execution path.

## Local Kill Switch, Budgets, And Blast Radius

`createLocalSafetyController()` is a local typed API for the existing `ghostapi-synthetic` action path. It persists kill switches scoped to global, organization, project, environment, agent, workload, provider, operation, or risk class. It also tracks monetary amount, request, message, mutation, delete, token-cost, concurrency, and velocity budgets under a lock, then opens persisted circuit breakers for configured failure-rate, policy-violation, latency, or reconciliation-mismatch conditions.

Emergency changes require an injected `SafetyEmergencyAuthorizer`. `safety.stop`, `safety.reenable`, and `safety.configure` are explicit distinct permissions, and every operation needs a safe bounded reason. There is no unauthenticated HTTP endpoint, no Slack/email/webhook approval transport, and no hosted control plane. The controller is local synthetic preparation and enforcement, not a provider kill switch.

Action approval is not a bypass: action execution admits a persisted budget reservation, and the synthetic world invokes the controller immediately before its atomic local commit. If a kill switch wins before that final check, the mutation is blocked. A side effect that already crossed the commit point is not claimed reversible. Replays with the exact idempotency/action hash do not consume a second budget; changed actions with the same idempotency key fail closed. Queues are bounded at 100 entries and stopped queued work moves to the local dead-letter queue without automatic retry.

The scheduled `GhostAPI Kill Switch Game Day` workflow runs the non-destructive local synthetic drill every Monday at `03:17 UTC`. Follow [`docs/operations/kill-switch-runbook.md`](operations/kill-switch-runbook.md) for detection, containment, investigation, recovery, and re-enable steps. Read [`docs/security/kill-switch-budgets-threat-model.md`](security/kill-switch-budgets-threat-model.md) before integrating any real provider action.

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

## Reliability: SLOs, Reconciliation, Cost Governance, And Runtime Health

The reliability layer is local-first and synthetic. It adds no provider, credential, or network surface.

### Runtime health

`GET /health` returns `{ ok, ready }` (liveness). `GET /health/readiness` returns the full structural report and HTTP 503 when a store is missing, oversized, corrupt, or a symlink. File stores are capped at 4 MiB each during the check.

```ts
import { checkRuntimeHealth, formatRuntimeHealth } from "@yiaany/ghostapi";
const report = await checkRuntimeHealth();
console.log(formatRuntimeHealth(report));
```

### SLOs

```ts
import { createLocalSloController, createSloRecordIdentity, createTestSloOperatorAuthorizer } from "@yiaany/ghostapi";

const { authorizer, issue } = createTestSloOperatorAuthorizer();
const operator = issue({ id: "sre", principalId: "sre-one", permissions: ["slo.configure", "slo.inspect"] });
const controller = createLocalSloController({ operatorAuthorizer: authorizer });
await controller.configureTarget({ identity: operator, target: { id: "availability.checkout", metric: "availability", windowMs: 60 * 60 * 1000, minimumSamples: 10, targetBps: 9_000 } });

const recordIdentity = createSloRecordIdentity(); // only the reconciliation service and its peers hold this
await controller.recordSample({ metric: "availability", ok: true, runId: "run-1", actionId: "action-1", labels: { tenantId: "tenant-a" } }, recordIdentity);

const report = await controller.evaluate({ identity: operator });
```

Recording requires the record capability; configuring/evaluating requires an authenticated operator. Samples are trimmed to the evaluation window and capped per metric.

### Reconciliation

```ts
import { createLocalReconciliationService, createWorldStateReconciliationProvider } from "@yiaany/ghostapi";

const service = createLocalReconciliationService({
  ledger, capability, provider: createWorldStateReconciliationProvider(async (actionId) => worldId),
});
const report = await service.runReconciliation();
```

Reconciliation exports the tenant ledger (blocked if integrity fails), classifies every action as `committed` / `not_committed` / `unknown` / `compensated` / `drifted`, derives SLI samples (duplicate-prevention, receipt verification, availability, execution latency), records them into the SLO controller, and opens findings for drifted/unknown actions. Resolutions require an operator with `reconciliation.manage`; unknown findings require provider evidence.

### Cost governance

```ts
import { createLocalCostGovernance, createTestCostOperatorAuthorizer } from "@yiaany/ghostapi";

const controller = createLocalCostGovernance({ operatorAuthorizer: authorizer });
await controller.recordCost({ identity: operator, record: { tenantId: "tenant-a", runId: "run-1", actionId: "action-1", attribution, amounts } });
const report = await controller.report({ identity: operator });
```

`report` returns totals, attribution dimensions, budget statuses, and a linear-extrapolation forecast that is explicitly not a provider invoice. Exceeded budgets with `alertOnExceed` raise acknowledgeable alerts.

### Backup and restore

```ts
import { backupRuntime, restoreRuntimeBackup } from "@yiaany/ghostapi";

const backup = await backupRuntime({ destinationDir: ".ghostapi/reliability/backups/drill-1" });
await restoreRuntimeBackup({ sourceDir: backup.path, targetDir: ".ghostapi-restored" });
```

Backups verify every file against a sha256 manifest, refuse to overwrite, and exclude `cache`, `runs`, `backups`, lock and temp files, and symbolic links. Restore re-verifies everything and rejects tampered or path-escaping manifests. See the [disaster-recovery runbook](operations/disaster-recovery-runbook.md).

## Agent Inventory And Attack-Path Graph

The inventory layer is local-first and synthetic. It imports agent, identity, tool, provider, resource, side-effect, credential, and policy records with provenance and freshness into `.ghostapi/inventory.json`, and it never reaches out to a source. ROI and removal numbers come from imported counters and the local store only.

```ts
import { createLocalInventoryController, createTestInventoryOperatorAuthorizer } from "@yiaany/ghostapi";

const { authorizer, issue } = createTestInventoryOperatorAuthorizer();
const operator = issue({ id: "invop", principalId: "invop-one", tenantId: "tenant-a", permissions: ["inventory.import", "inventory.inspect", "inventory.analyze", "inventory.remediate", "inventory.export"] });
const controller = createLocalInventoryController({ operatorAuthorizer: authorizer });

await controller.import(operator, {
  schemaVersion: 1,
  kind: "ghostapi.inventory-import",
  source: { sourceId: "repo-config", sourceType: "config", sourceName: "Repo config" },
  agents: [{ agentId: "agent-order", name: "Order assistant", identityIds: ["identity-order"], environmentIds: ["production"], gatewayManaged: true, killSwitchEnabled: true }],
  identities: [{ identityId: "identity-order", principalId: "svc-order", role: "service_account", toolIds: ["tool-stripe"], environmentIds: ["production"], scopes: ["read", "charge"] }]
});
```

Imports carry a digest; re-importing the same payload refreshes freshness without duplicating records or edges. Every graph edge has provenance (`source`, `importedAt`, `importedBy`) and a freshness status.

```ts
const snapshot = await controller.inspect(operator);          // tenant-scoped records, edges, findings
const paths = await controller.attackPaths(operator, "agent-order");
const blast = await controller.blastRadius(operator, "agent-order"); // heuristic-labeled, advisory
const { findings } = await controller.analyze(operator);       // detections on the current store
const exported = await controller.export(operator);            // inventory, policies, evidence, ROI
```

Detections cover orphaned agents, stale/unused credentials, excessive permissions, unowned production integrations, agents outside the gateway, missing kill switches, missing evidence, and policy drift. Heuristic findings are explicitly labeled; coverage gaps are surfaced as risk, not ignored.

Remediations are proposed against a finding and applied locally: assign an owner, reduce credential scopes (never expanded — proposals that add or keep scopes are rejected), revoke a credential, onboard an agent through the gateway, or create an eval scenario reference.

```ts
const excessive = snapshot.findings.find((finding) => finding.kind === "excessive_permissions");
const proposal = await controller.proposeRemediation(operator, {
  findingId: excessive!.findingId, kind: "reduce_scope", targetKind: "credential", targetId: "cred-stripe",
  rationale: "Drop the unused admin scope.", reducedScopes: ["read", "charge"]
});
await controller.applyRemediation(operator, proposal.remediationId);
```

The ROI report uses only imported counters and applied remediations; unmeasured values are `null` and listed in `notMeasured`. See the [inventory threat model](security/inventory-threat-model.md). The entry gate for enterprise numbers (a real pilot) is not yet met; results are for local synthetic review.

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
