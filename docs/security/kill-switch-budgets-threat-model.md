# Local Kill Switch, Budget, And Blast-Radius Threat Model

## Scope

The Session 27 safety controller is a local, persisted coordination layer for the existing `ghostapi-synthetic` action path. It implements local kill switches, budgets, circuit breakers, bounded queue/dead-letter state, authenticated emergency API calls, audit records, and a scheduled synthetic game-day test. It does not introduce a provider, provider SDK/client, provider account, vault, credential, external HTTP, webhook/email/Slack transport, hosted control plane, or production side effect.

## Emergency Authority

`stop()`, `reenable()`, `configureBudget()`, and `configureCircuit()` require an injected `SafetyEmergencyAuthorizer`. The API accepts only verifier-issued operator objects with a stable principal and explicit permission. `safety.stop`, `safety.reenable`, and `safety.configure` are separate permissions. Empty, secret-shaped, or oversized reasons fail closed and every emergency decision is chained into the bounded local audit log.

There is intentionally no unauthenticated HTTP emergency endpoint, no CLI token parser, and no notification transport. A future deployment needs a separately reviewed identity authority and authenticated transport before exposing this emergency API remotely.

## Enforcement Semantics

- Switch scopes are `global`, `organization`, `project`, `environment`, `agent`, `workload`, `provider`, `operation`, and `risk_class`.
- Admission serializes against the persisted controller store. Budgets reserve action costs before execution, so parallel callers cannot oversubscribe money, requests, messages, mutations, deletes, token cost, concurrency, or velocity limits.
- A replay with the same idempotency key and action hash returns a replay lease without a second reservation. Reusing the key with a different action hash is denied.
- The action gateway calls the controller after plan/simulate and before its attempt record. The synthetic world calls the controller's `commit()` while it holds its own world lock. `commit()` is two-phase: a first mutate re-checks the lease, expiry, and kill-switch/circuit state; only then is the operation executed; a second mutate re-checks the lease and persists the `action.final_check` audit record ("remained active through commit") before returning. A kill switch that wins before the first phase blocks the local mutation. If the lease expires between the phases, `commit()` throws even though the operation already ran — the caller must not treat the action as successfully admitted.
- Leases are time-bounded: a reserved lease expires after `DEFAULT_LEASE_TTL_MS` (60 s by default, overridable via `leaseTtlMs`). Expired leases are pruned on the next admission, and both `assertActive()` and the `commit()` phases reject an expired lease. `complete()` is tolerant: it still records the outcome for a lease that expired after the operation, so the audit chain reflects what actually happened instead of dropping the terminal record.
- Kill-switch denials carry the stable error code `SAFETY_KILL_SWITCH` (and admit/commit errors are `SafetyControllerError`), so callers — including the scheduled game day — detect a kill-switch block structurally instead of by parsing message text.
- Queued actions have a fixed maximum of 100. A full queue returns backpressure. Stopping a matching scope moves queued records to the bounded dead-letter queue; no queued action is auto-retried. The dead-letter queue is also bounded, and when full the oldest entry is evicted so the store never grows without limit.
- Already approved is not already executable: approval artifacts still pass current policy, identity, idempotency, safety admission, and final-commit checks. An in-flight action that has crossed the final commit cannot be undone; GhostAPI does not claim rollback. A real provider would require idempotency and reconciliation semantics before an equivalent boundary is enabled.
- Failures, policy violations, latency threshold breaches, and reconciliation mismatches can open persisted circuit breakers. Open breakers deny new admission; no retry loop is created by the controller.

## Persistence And Limits

Critical state lives in `.ghostapi/safety-controller.json`, not process memory. It is strict-schema validated, bounded to 1 MiB, guarded as a regular non-symlink file, serialized with the existing file lock, atomically replaced, and covered by a bounded SHA-256 audit chain. This is local coordination and tamper evidence on one filesystem, not a distributed lock, immutable audit ledger, or defense against a malicious same-user actor who can modify both state and runtime.

## Game Day And Runbook

The scheduled GitHub workflow runs only `test/safetyController.test.ts`, which performs a local synthetic stop/re-enable drill and never creates a provider side effect. The operational procedure is in [`docs/operations/kill-switch-runbook.md`](../operations/kill-switch-runbook.md).

## Remaining Limits

- The controller does not authorize production execution, reconcile a provider outcome, revoke a provider credential, or prove a provider-side stop.
- Budget units are caller-supplied typed action metadata for the one local synthetic action; a future real action needs independently derived and provider-verified amounts/costs.
- Local timestamps use the process clock. A real deployment needs a trusted clock, durable audit sink, shared atomic store, reconciliation, and provider-specific final-side-effect guards.
