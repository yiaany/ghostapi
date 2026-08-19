# Reliability Surface Threat Model

Applies to the local reliability layer: SLO controller, reconciliation service, cost governance, runtime health, and backup/restore.

## Scope

This threat model covers the reliability module added in the "reliability" session:

- `slo.json`, `reconciliation.json`, `costs.json` local persisted stores under `.ghostapi/reliability/`.
- Backup and restore of the whole local data directory, including the reliability stores.
- `/health` and `/health/readiness` HTTP endpoints backed by `checkRuntimeHealth`.
- Reconciliation reading the action ledger and the synthetic worlds directory.

`checkRuntimeHealth` treats every canonical store as a first-class dependency, including `inventory.json` (`inventoryStore`), so a corrupt or missing inventory store is reported as `degraded` and flips readiness, not just the reliability stores.

The reliability layer adds no provider, credential, network egress, or hosted control-plane surface. All of it is local-first and synthetic.

## Trust Boundaries

| Boundary | In scope | Out of scope |
| --- | --- | --- |
| Operator identity | SLO, reconciliation, and cost operators authenticate through injectable authorizers; the test authorizer binds issued identities by reference | Real authn/authz infrastructure |
| Ledger access | Reconciliation uses a verified ledger capability (reference-bound, tenant-scoped, permission-checked) | Key management for live providers |
| Provider state | Reconciliation inspects synthetic worlds through `createWorldStateReconciliationProvider` | Live provider APIs |
| HTTP surface | `/health`, `/health/readiness` are public but return only structural readiness | Authenticated control APIs |

## Assets

- SLO samples and configured targets (`slo.json`).
- Reconciliation findings, resolutions, and last-run state (`reconciliation.json`).
- Cost records, budgets, alerts (`costs.json`).
- Backup manifest and copies (`reliability/backups/`).
- The runtime health report (derived, not persisted).

## Threats And Mitigations

### T1. Unauthorized SLO recording poisons availability targets

`recordSample`/`recordSamples` accept a capability object instead of an operator identity. The capability must be a member of the record-capability set created by `createSloRecordIdentity`; any other object is rejected with "record capability". This is reference-bound, so ambient objects cannot be forged.

Samples are bounded: `MAX_SAMPLES_PER_METRIC` (5,000), `MAX_SAMPLES` (10,000) globally, enforced on every mutation, and `recordSamples` caps each call at `MAX_RECORD_BATCH` (1,000) so a single oversized call cannot blow past the store bound. SLO store bytes are capped at 4 MiB.

Latency evaluation only counts samples whose `ok` flag is true; a latency breach requires both `sample.ok === true` and `durationMs` above the target. Failed samples can no longer be counted as "within SLO" by reporting a low duration.

### T2. Operator impersonation on configure/evaluate/inspect

Every SLO operator action authenticates through the configured authorizer and validates permissions against `slo.configure`/`slo.inspect` only. Identities are reference-bound objects issued by the authorizer; a plain `{}` or any other object is rejected as "not authenticated".

### T3. Reconciliation reads a tampered ledger

`runReconciliation` requires the operator to hold the `reconciliation.manage` permission and takes an explicit `{ identity }` input; a read-only operator is rejected. It calls `exportTenant`; if ledger integrity verification fails, reconciliation is blocked with a clear error and no findings or SLO samples are written. A tampered ledger cannot silently produce a "valid" report. Provider read failures are detected structurally (`SyntheticWorldError` with code `WORLD_NOT_FOUND`) rather than by matching error text, so a missing world is reported deterministically.

### T4. Reconciliation leaks or records sensitive provider evidence

Provider receipts are reduced to `{ actionId }` for matching, and worlds are inspected through the same receipts shape. Findings carry only `actionHash` and bounded non-secret `detail`/`evidenceRef` strings (validated by `identifier`/`hash`/`evidence`/`text`, which reject control characters and secret-shaped values via `sanitizeSecretString`).

### T5. Cost store is poisoned or exploded

Cost records are capped (`MAX_RECORDS` 10,000), budgets capped (`MAX_BUDGETS` 32), alerts capped (`MAX_ALERTS` 100), window capped (`MAX_WINDOW_MS` 90 days), store bytes capped at 4 MiB. Amounts are non-negative integers. `recordCost` is idempotent per tenant: a duplicate `actionId` for the same tenant is rejected, so a replay of a cost record cannot double-charge a budget. `report()` is a pure read — it never writes alert state; only `listAlerts()` persists derived alerts. Reports and alerts are scoped to the operator's tenant via the optional `CostOperator.tenantId`, and alerts honor each budget's `alertOnExceed` flag, so an explicit opt-out cannot be overridden by a global alert pass. Forecast output is explicitly labeled as a linear extrapolation approximation, not a provider invoice.

### T6. Backup/restore path traversal

Restore validates every manifest entry path with `normalizeEntryPath` (rejects `..`, absolute paths, drive-letter prefixes, NUL bytes) and `assertContained` bounds every source and target path within its root. A crafted manifest that escapes the backup root is rejected before any file is written.

### T7. Tampered backup restores bad data

Restore requires `manifest.verified === true` and re-verifies sha256 and size of every entry before and after copy, plus JSON structure for `.json` entries. Tampering with any backed-up file fails "integrity verification" and aborts the restore.

### T8. Backup exfiltrates or follows unsafe links

`collectBackupFiles` refuses symbolic links, non-regular files, `.lock`/`.tmp` files, and refuses the whole backup if any is encountered. Exclusions are path-based, not name-based: only the canonical `cache` and `backups` directories, the current destination, and a top-level `runs` directory are skipped — a nested directory merely named `cache` or `backups` inside a world/contract is still backed up. Because the canonical backups location is excluded, backups do not recursively include earlier backups.

### T9. Runtime health check is a denial vector

Store files are read with `MAX_CHECK_FILE_BYTES` (4 MiB) cap; oversized or non-JSON stores are reported as `degraded`, never loaded fully. The `/health` endpoint returns only `{ ok, ready }`; `/health/readiness` returns the structural report and 503 when not ready.

### T10. Backup/restore destroys the source

Backup only reads the source; restore refuses a target that is the source or inside it, and refuses to restore into a non-empty target directory, so an existing data directory cannot be silently overwritten. Copy is byte-verified before the atomic write to the destination, and failed copies clean up the partial destination.

## Permissions And Capabilities Summary

| Action | Check |
| --- | --- |
| SLO record | record capability in `sloRecordCapabilities` |
| SLO configure/inspect/evaluate | operator authorizer + `slo.configure`/`slo.inspect` |
| Reconciliation run | operator authorizer + `reconciliation.manage` + ledger capability (tenant-scoped, `export`) |
| Reconciliation findings/resolve | operator authorizer + `reconciliation.inspect`/`reconciliation.manage` |
| Cost record/configure/report/alerts | operator authorizer + `cost.*` permissions |
| Health/backup/restore | local-only; backup/restore are not exposed over HTTP |

## Limits

| Resource | Limit |
| --- | --- |
| SLO samples per metric | 5,000 |
| SLO samples total | 10,000 |
| SLO targets | 32 |
| SLO window | 1 hour .. 30 days |
| Reconciliation findings | 1,000 |
| Cost records / budgets / alerts | 10,000 / 32 / 100 |
| Cost window | up to 90 days |
| Store bytes | 4 MiB each |
| Backup total bytes | 64 MiB |
| Health check file bytes | 4 MiB |

## Out Of Scope

- Live SLO alerting to external systems (no egress was added).
- Multi-node reconciliation consensus (local single-process semantics).
- Backup to remote/object storage (local directory only).