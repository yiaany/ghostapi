# Local Approval Inbox Threat Model

## Scope

The approval inbox is a local typed API for the existing `ghostapi-synthetic` action adapter. It does not enable production providers, credentials, deployments, money movement, email, Slack, webhooks, browser approval links, or external notifications.

An approval request is derived from a strict action envelope and its canonical SHA-256 hash. The action's risk is derived by the inbox taxonomy, never accepted from the agent as mutable input. The current synthetic operation maps to `update`; the taxonomy also reserves `read`, `create`, `communicate`, `money_movement`, `delete`, `permission_change`, and `deployment` for future reviewed action contracts.

## Policy And Display

An approval policy can restrict environment, actor, resource, amount, confidence, and action velocity. It defines an expiry and escalation timeout. A request exposes its normalized arguments, exact target, expected effects, reversibility, amount availability/value, policy reason, evidence hash, and successful synthetic preflight result. Missing amount evidence fails a policy that sets a maximum amount.

## Approval Invariants

- Requests, decisions, artifacts, and audit records are strict schema-v1 local data under `.ghostapi/approvals.json`.
- Approver identities come from an injected verifier and include a verified stable `principalId`. Unverified caller-shaped objects fail closed.
- An action actor/workload cannot approve its own action through its approver ID, verified principal ID, or independence key.
- Critical risks or low confidence require distinct verified principals and `independenceKey` values; aliases cannot satisfy two-person approval.
- Approval artifacts are action-hash-bound, one-time, expiring, and carry Ed25519 provenance from a durable approval-authority key. They are consumed under the inbox lock before execution starts; resumption never issues or consumes a second artifact.
- The gateway verifies the signature at submission and again from the persisted record at execution. Inbox artifacts also require verifier-confirmed durable request state with the same request ID, action hash, artifact, and `consumedAt`; the request must be `executing`, or already `executed` with a linked receipt hash. Returning an already completed result additionally requires the inbox's stored receipt hash to match the gateway's durable verified receipt. A gateway configured with only the signing authority's public key cannot execute an inbox artifact.
- Rejection, revoke, timeout, expiry, policy drift, changed action, or changed execution identity deny execution.
- Edit-and-resubmit supersedes the prior request and requires a changed canonical action hash.
- The inbox rechecks the policy at execution and then delegates only to the existing action gateway, which repeats provenance/action/approval/policy/identity/idempotency checks before its synthetic side effect.
- Every approval transition and verified action receipt are connected through one local SHA-256 audit chain. Local chains are tamper-evident only under the existing filesystem trust model.

## Race And Recovery

The inbox serializes approval state and artifact consumption with one private file lock. A revoke that acquires the lock first prevents the side effect; an execution that has consumed the artifact first cannot be revoked as if it were still pending. If the process stops after durable `consumedAt`/`executing` state, recovery resubmits the identical signed artifact and delegates to the gateway's receipt chain. A `requested` receipt continues normally only while the action and approval remain valid; an `attempted` or `committed` receipt can be reconciled after expiry because no new attempt is permitted, and a `verified` receipt is returned without another side effect. The inbox changes to `executed` only after linking that verified receipt hash into its audit chain. Repeated recovery and calls after completion return the same verified receipt. A durable gateway `failed` receipt makes the inbox terminally `execution_failed`; an absent receipt or ambiguous attempted outcome remains `executing` and fail-closed rather than being replayed. Artifact data, local hashes, and filesystem write access are not sufficient to mint new valid approvals without the private signing key. Key rotation is explicit through trusted key IDs; unavailable or unknown verifiers deny recovery and execution.

## Remaining Limits

- The inbox is an API, not a hosted UI or notification channel. Slack/email text must never become an approval source of truth.
- Signing keys are injected; GhostAPI does not generate, escrow, rotate, or recover durable production key material. Operators must keep private keys outside the data directory and distribute only trusted public keys to executors.
- There is no authentication transport, RBAC service, trusted OIDC integration, external immutable audit sink, real clock authority, policy engine for production action classes, or real provider executor.
- A future production integration requires an independently deployed identity/approval authority, provider-specific impact schema, policy authorization, credential broker, kill switch, budgets, durable audit evidence, timeout reconciliation, and compensation semantics.
