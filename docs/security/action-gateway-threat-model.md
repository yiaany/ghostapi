# Synthetic Action Gateway Threat Model

## Scope

The Session 23 action gateway is a local, data-only implementation of the shared action contract. Its only executor is `ghostapi-synthetic`, which mutates an existing local synthetic world. It has no provider HTTP client, credential input, environment-secret lookup, account configuration, shell execution, webhook delivery, or cloud transport.

It is not a production gateway. Real provider accounts, credentials, sandbox accounts, provider calls, external messages, money movement, deployments, and deletes are out of scope until the Session 23 entry gate has documented design-partner requirements, a separate test account, an approved threat model, and explicit owner authorization.

## Trust Boundaries

- Agent input: `ActionEnvelope` is untrusted data and is strictly schema-validated.
- Approval input: `ActionApproval` is structured data bound to the canonical SHA-256 action hash. A boolean approval is not accepted.
- Policy input: the current local policy is loaded again at submit and execute; its version and SHA-256 source hash must match the approved envelope.
- Identity input: the execution actor/workload pair must match the approved envelope immediately before side effect.
- Persistence: action records use a private local directory, per-action lock, atomic replacement, regular-file checks, byte bounds, and receipt-chain validation. This coordinates cooperating local processes only; it is not protection from a malicious same-user actor who can alter both state and runtime.
- Synthetic adapter: execution delegates only to the existing atomic synthetic-world workflow. It has no ambient network or credential capability.

## Invariants

- Canonical serialization sorts object keys and preserves array order. Any argument change changes the action hash and invalidates approval.
- An approver cannot equal the action actor or workload identity.
- Action expiry, approval expiry, policy reference, actor identity, adapter support, and idempotency state are checked immediately before execution.
- Receipts distinguish `requested`, `attempted`, `committed`, `verified`, and `failed`. Each receipt hashes the prior receipt hash plus its canonical content.
- An `attempted` action is reconciled with `verify` before any subsequent execution. A failed reconciliation is an unknown outcome and is never automatically retried.
- Duplicate action IDs with a changed envelope or approval are rejected. A verified or committed action returns its existing receipt without another synthetic side effect.
- Unsupported operations and unsupported compensation fail visibly. The API uses `compensate`, never `rollback`; the current synthetic adapter exposes no compensation.

## Remaining Limits

- Policy schema v1 does not yet express action-level authorization. The gateway rechecks the approved policy version/hash to prevent stale-policy execution; a later production policy extension must add an explicit action decision before exposing a non-synthetic adapter.
- Local receipt chaining is tamper-evident only while the local store and runtime are trusted. It is not an externally immutable ledger or a legal audit record.
- A future provider adapter must provide provider-specific idempotency proof, safe reconciliation for timeout ambiguity, credentials held behind a broker/gateway boundary, scoped grants, kill-switch/budget checks, durable audit evidence, and explicit compensation semantics before it can execute any real side effect.
