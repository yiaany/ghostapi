# Credential Broker And Workload Identity Threat Model

## Scope

The credential broker is a local typed library for a future execution gateway. It does not expose a CLI, MCP tool, HTTP endpoint, environment-variable loader, provider SDK, or credential-return API. The agent/workload never receives upstream secret material through arguments, stdin, environment variables, logs, reports, grants, receipts, or persisted broker metadata.

Only server-side execution can read a secret. A caller presents a verified workload identity, a short-lived grant, and an exact action reference. The broker reads secret bytes from an injected vault boundary, passes them directly to an injected server-side executor, then zeroes the temporary byte buffer in a `finally` block. It returns a receipt, never the secret or a bearer token.

The included `test-memory-vault`, test executor, workload verifier, action-receipt verifier, and break-glass authorizer exist only for automated tests. They have no network, provider, environment-secret, account, or production side-effect capability. A real integration must supply an existing reviewed vault/KMS adapter and a separately reviewed provider executor; GhostAPI does not implement encryption, key wrapping, or a provider credential protocol.

## Secret Lifecycle

1. Provisioning: an operator registers non-secret metadata: tenant, project, environment, provider, owner workload binding, scope allowlist, expiry, and opaque vault reference. The vault owns secret creation and storage.
2. Storage: GhostAPI stores only metadata, grant metadata, and use receipts in `.ghostapi/credential-broker.json`. It rejects unknown fields, symlinks, oversized state, secret-shaped identifiers, and plaintext secret fields. A vault reference is not secret material and must not encode a secret.
3. Use: an authenticated workload requests a server-only grant for one exact action ID, action hash, and verified action receipt hash. The broker rechecks workload, tenant/project/environment, provider, scopes, credential status, grant status, expiry, and action reference immediately before vault access and execution.
4. Rotation: rotation replaces the opaque vault reference, increments the credential version, and revokes every outstanding grant. It does not touch local synthetic worlds, so local simulation stays available.
5. Revocation: credential revocation marks the credential and all active grants revoked. New execution attempts are denied before vault access.
6. Audit: broker state records action-linked grant metadata and bounded execution receipts. It never stores the secret, a raw provider request, or an executor response body.
7. Recovery: execution failures receive a failed receipt and are never automatically retried. Provider-specific reconciliation and duplicate-side-effect handling remain required before a real executor is enabled.

## Workload Identity

Schema-v1 workload identities distinguish `agent_run`, `ci_job`, and `production_service`. Each identity binds tenant, project, environment, workload ID, subject ID, run ID, issue time, and expiry. The broker accepts an identity only through an injected verifier; unverified caller-shaped objects fail closed.

The identity verifier can additionally report whether an owner workload remains active. `listOrphanedCredentials()` returns non-revoked credentials whose owner workload binding is no longer active, so an operator can revoke or rotate them. It does not automatically broaden, transfer, or delete access.

## Invariants

- The grant audience is always `ghostapi-server`; no grant is valid for an agent process.
- A grant is bounded to one tenant, project, environment, workload kind/ID, provider, sorted scope list, credential version, TTL, and exact action receipt.
- Standard grants last at most 15 minutes. Break-glass grants require an independent trusted authorizer and last at most 5 minutes.
- Credential metadata and secret material are separate interfaces. Metadata cannot reconstruct the upstream value.
- Broker and executor both enforce scope. The executor rejects unsupported scope even if a caller somehow reaches it after broker validation.
- A rotated credential invalidates old grants through both revocation and version mismatch. A revoked or expired grant is rejected even when an old request is replayed.
- Cross-tenant, project, environment, workload, scope, audience, action, and receipt mismatch all fail closed before secret access.
- A provider executor must create an action-linked receipt. The current test executor has no real provider capability.

## Break-Glass

Break-glass is disabled by default. An implementation must use a trusted human-controlled approval system that validates a short-lived structured approval bound to the exact action ID/hash/receipt. The approver cannot equal the workload subject or workload ID. The broker stores only approval ID, approver ID, and bounded reason in the grant; it does not store an approval token.

## Crash And Memory Limits

Node.js does not offer a universal guarantee that secret bytes are absent from every process snapshot, heap copy, debugger, or OS crash dump. The broker minimizes exposure by avoiding strings, logs, environment variables, arguments, persistence, and return values; it uses a temporary `Uint8Array` and clears that buffer after executor completion or failure. Operators must still disable or protect crash/core dumps, debugger attachments, and untrusted process inspection in any real deployment.

## Remaining Limits

- This is not a production vault, KMS, HSM, hosted identity provider, approval inbox, provider client, or production action gateway.
- Local JSON storage is coordination and tamper detection only under the existing single-user filesystem trust model; it is not immutable audit storage.
- A real provider executor needs its own test-account gate, provider idempotency/reconciliation proof, action-level policy decision, kill switch, budgets/velocity controls, durable audit sink, timeout ambiguity handling, and compensation semantics before any real side effect is enabled.
