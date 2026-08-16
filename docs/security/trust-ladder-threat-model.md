# Local Synthetic Trust Ladder Threat Model

## Scope

The Session 26 trust ladder is a local, synthetic, data-only preparation layer. It models `simulate`, `shadow`, `dry-run`, `approve`, `bounded-auto`, and `trusted` capability contracts, promotion evidence, canary eligibility, comparisons, rollback reasons, and audit records. It does not execute an action and does not integrate with the action gateway, approval inbox, credential broker, vault, provider SDK/client, external HTTP, provider account, test account, hosted control plane, or notification transport.

The local synthetic runtime is not production authorization. `trusted` is intentionally unsupported. `dry-run` is unsupported because no provider-official safe dry-run semantic exists for `ghostapi-synthetic`; it is never emulated by ordinary execution.

## Trust Boundaries

- Target identities are strict synthetic-only values. Production and test-account identities are rejected rather than mixed into local state.
- Owner decisions arrive only through an injected verifier and compare the verifier-issued stable `principalId` to policy. Caller-shaped owner objects fail closed.
- Promotion evidence is bounded metadata: run count, violation/error count, named eval status, and timestamps. LLM confidence is not a signal.
- Shadow comparisons accept only SHA-256 action/context metadata and return matching evidence. They do not read raw provider inputs or invoke an adapter.
- Bounded outcome comparisons accept only action/outcome/receipt hashes. They do not perform the bounded execution being assessed.
- State uses private local storage, regular-file/symlink checks, byte limits, a file lock, atomic replacement, and a bounded SHA-256 audit chain. This is coordination/tamper evidence under the existing local filesystem model, not an immutable audit sink.

## Invariants

- Every local capability declares `externalSideEffects: false`.
- `dry-run` and `trusted` are explicitly unsupported; unsupported levels cannot be promoted into.
- Promotion has no automatic path. It requires the configured verified owner, fresh evidence, minimum runs, every required passing eval, and violation/error rates at or below policy thresholds.
- Promotion advances only to the next supported level, so an operator cannot skip review stages.
- Canary assignment is deterministic from a SHA-256 policy/target bucket, checks tenant and resource scope first, and uses a 0-10,000 basis-point percentage.
- A canary violation can immediately demote the target to `approve` or open the circuit breaker based on policy. Stop conditions open the breaker. Once open, no further assignment, comparison, or canary outcome is accepted.
- `rollbackToApproval()` requires the verified policy owner and appends an audit record with the supplied bounded reason.
- The implementation cannot mutate a synthetic world or a provider because it has no execution dependency or capability.

## Remaining Limits

- Shadow and outcome evidence compare supplied hash metadata. They cannot prove a real provider request or external outcome because the implementation deliberately has no provider transport.
- This is not an approval authority, action-level policy engine, kill switch for a real provider, budget/velocity enforcement gateway, reconciliation service, test-account boundary, or production audit system.
- A future real provider integration requires a separately reviewed provider-specific identity model, official dry-run proof where claimed, action authorization, inbox/credential execution boundary, idempotency and reconciliation semantics, kill switch, budgets, durable audit storage, and explicit owner/test-account gates before any side effect is enabled.
