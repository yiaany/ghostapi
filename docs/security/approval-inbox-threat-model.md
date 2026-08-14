# Local Approval Inbox Threat Model

## Scope

The approval inbox is a local typed API for the existing `ghostapi-synthetic` action adapter. It does not enable production providers, credentials, deployments, money movement, email, Slack, webhooks, browser approval links, or external notifications.

An approval request is derived from a strict action envelope and its canonical SHA-256 hash. The action's risk is derived by the inbox taxonomy, never accepted from the agent as mutable input. The current synthetic operation maps to `update`; the taxonomy also reserves `read`, `create`, `communicate`, `money_movement`, `delete`, `permission_change`, and `deployment` for future reviewed action contracts.

## Policy And Display

An approval policy can restrict environment, actor, resource, amount, confidence, and action velocity. It defines an expiry and escalation timeout. A request exposes its normalized arguments, exact target, expected effects, reversibility, amount availability/value, policy reason, evidence hash, and successful synthetic preflight result. Missing amount evidence fails a policy that sets a maximum amount.

## Approval Invariants

- Requests, decisions, artifacts, and audit records are strict schema-v1 local data under `.ghostapi/approvals.json`.
- Approver identities come from an injected verifier. Unverified caller-shaped objects fail closed.
- An action actor/workload cannot approve its own action.
- Critical risks or low confidence require two distinct `independenceKey` values; aliases of the same identity cannot satisfy two-person approval.
- Approval artifacts are action-hash-bound, one-time, expiring, and consumed under the inbox lock before execution starts.
- Rejection, revoke, timeout, expiry, policy drift, changed action, or changed execution identity deny execution.
- Edit-and-resubmit supersedes the prior request and requires a changed canonical action hash.
- The inbox rechecks the policy at execution and then delegates only to the existing action gateway, which repeats action/approval/policy/identity/idempotency checks before its synthetic side effect.
- Every approval transition and verified action receipt are connected through one local SHA-256 audit chain. Local chains are tamper-evident only under the existing filesystem trust model.

## Race And Recovery

The inbox serializes approval state and artifact consumption with one private file lock. A revoke that acquires the lock first prevents the side effect; an execution that has consumed the artifact first cannot be revoked as if it were still pending. Execution failures are recorded and remain fail-closed; no automatic retry or compensation is claimed.

## Remaining Limits

- The inbox is an API, not a hosted UI or notification channel. Slack/email text must never become an approval source of truth.
- There is no authentication transport, RBAC service, trusted OIDC integration, external immutable audit sink, real clock authority, policy engine for production action classes, or real provider executor.
- A future production integration requires an independently deployed identity/approval authority, provider-specific impact schema, policy authorization, credential broker, kill switch, budgets, durable audit evidence, timeout reconciliation, and compensation semantics.
