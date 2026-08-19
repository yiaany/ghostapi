# Local Action Ledger And Incident Replay Threat Model

## Scope

The local action ledger is a typed API for turning an already persisted synthetic action record into a tenant-scoped, append-only timeline. It records hashes and bounded structured facts for intent, identity, policy decision, approval, credential-grant reference, attempts, provider receipt, verification, compensation status, and governance events.

It does not add a provider client, provider account, credential vault, HTTP transport, production execution path, production credential, hosted audit service, legal/compliance service, or immutable external storage. The current incident pipeline turns a ledger action into one local deterministic synthetic world plus one data-only scenario bundle. Replay uses the existing in-memory `ScenarioReplayer`; it makes no network request and cannot use original credentials.

## Integrity And Privacy

- Each tenant has its own SHA-256 genesis hash and ordered hash chain. Every entry binds its tenant, sequence, timestamp, action reference, stage, structured fields, and previous hash.
- Tenant metadata stores the current entry count and head hash. Verification detects modified content, reordered entries, removed entries, invalid links, and a mismatched head/count.
- The store is bounded, strict-schema validated, regular-file/non-symlink checked, serialized with the existing local file lock, and atomically replaced.
- Ledger values are scalar-only. Raw arguments, payloads, authorization, cookies, tokens, secret/password fields, email, phone, address, card, and body/payload fields are rejected. Action/resource/provider references are persisted only as stable IDs or SHA-256 hashes where the identifier could expose sensitive data.
- Export verifies the requested tenant chain first and returns entries only for the tenant authorized by the injected access authorizer. It contains no credential material or raw action payload.

## Outcome Semantics

- A `verified` ledger stage is emitted only from a gateway `verified` receipt.
- A failed receipt with `unknown_outcome` becomes `ambiguous` and `requires_reconciliation`; it is never relabeled successful.
- A committed receipt without a verified receipt remains unverified. The incident fixture reproduces this distinction locally with `409 requires_reconciliation` rather than inventing success.
- Credential use is a reference only: `grantIdHash`, credential version, or `not_used`. The ledger never receives or exports the underlying secret.

## Retention, Hold, And Deletion

- `configureRetention()` records a per-tenant retention policy. `appendEntry` enforces the store bound (`MAX_ENTRIES` 2,000): when the cap is reached, entries older than the tenant's `retentionDays` are rotated out and the tenant's hash chain is relinked to genesis — `previousHash`/`entryHash` are recomputed and `entryCount`/`headHash` updated, so a subsequent `verifyTenant` still passes. Rotation is bounded and never silent at the cap: if the store cannot be brought under `MAX_ENTRIES`, the append is rejected with an explicit retention-review error.
- Rotation is per-tenant and opt-in: a tenant without a `retentionDays` policy is never rotated (its chain remains strictly append-only), and a tenant under `setLegalHold(true)` is never rotated.
- `setLegalHold(true)` records an active local hold and blocks `requestDeletion()`.
- `requestDeletion()` records a request timestamp after the hold check. It does not erase entries, backups, or external copies and does not claim GDPR, SEC, HIPAA, or any other compliance behavior.
- A real retention/deletion workflow needs an approved retention schedule, backup lifecycle, legal authority, trusted identity, durable external evidence, and a cryptographically preserved anchor before destructive deletion can be designed.

## Claimed Basis And Verification

- `policy_decision` and `approval` stages echo caller-supplied decisions as `basis: "caller_claimed"` — they record what the caller asserted at admission time, not an independently verified policy/approval decision, and consumers must treat them as claims.
- `verifyTenant()` returns `tracked: false` with the tenant's genesis hash as head for a tenant that has no entries, and `tracked: true` for a tenant with entries, so "no ledger yet" is distinguishable from a broken or tampered chain.

## Trust Boundaries And Limits

- `LedgerAccessAuthorizer` is injected. The default authorizer denies everything. Test capability helpers are only local test utilities, not authentication or tenant isolation for a deployed service.
- Tenant isolation applies to calls that go through a correct injected authorizer. A malicious same-user actor who can replace the local state file and runtime is outside this local filesystem model.
- The chain is tamper-evident, not absolutely immutable. It does not defend against a compromised host, altered application code, deleted backups, an attacker who replaces both data and trusted head/anchor, distributed filesystems, or a dishonest clock.
- Sanitization is structural and pattern-based. Operators must inspect incident fixtures before sharing them; GhostAPI does not guarantee perfect anonymization.
