# Disaster-Recovery Runbook

Local backup and restore for the GhostAPI data directory (`GHOSTAPI_DATA_DIR`, default `.ghostapi/`).

## When To Use This

- You are replacing or moving the local data directory and need a verified copy.
- A store is corrupt (`ghostapi` reports a degraded runtime health) and you want to restore from a known-good backup.
- You are running a quarterly DR drill: back up, destroy, restore, verify.

## Before You Start

- Run `ghostapi start` is NOT required. Backup and restore work on a stopped or running instance, but restoring over a running instance is not supported — stop the instance first.
- Backups are local directory copies with sha256 manifests. They are not encrypted, do not contain upstream secrets (the credential broker persists metadata only), and are not a substitute for object-storage or offsite backup.
- The default backup destination is `.ghostapi/reliability/backups/backup-<timestamp>-<id>/`. Because the `backups` directory is excluded from future backups, backups never recursively include one another.

## Backup

Backup is available programmatically:

```ts
import { backupRuntime } from "@yiaany/ghostapi";
const result = await backupRuntime({ destinationDir: ".ghostapi/reliability/backups/manual-drill" });
// result: { backupId, path, fileCount, totalBytes, verified: true, createdAt }
```

The backup verifies every copied file (size + sha256 + JSON structure for `.json` entries) and refuses to overwrite an existing destination. `result.verified` is only true after full verification.

## Restore

```ts
import { restoreRuntimeBackup } from "@yiaany/ghostapi";
await restoreRuntimeBackup({ sourceDir: ".ghostapi/reliability/backups/manual-drill", targetDir: ".ghostapi-restored" });
```

Then point the runtime at the restored directory:

```bash
export GHOSTAPI_DATA_DIR=/absolute/path/to/.ghostapi-restored
ghostapi doctor
```

Restore refuses:

- A backup whose manifest was not verified at creation time.
- Any manifest entry path that escapes the backup root (path traversal).
- A target that is the backup source itself or inside it.
- Any entry whose bytes no longer match the manifest (tamper detection).

## Verification Steps After Restore

1. `ghostapi doctor` reports healthy.
2. `curl http://127.0.0.1:8080/health` returns `{ "ok": true, "ready": true }`.
3. `curl http://127.0.0.1:8080/health/readiness` returns HTTP 200 with a `ready: true` report. A 503 means the restored directory has a degraded store — do not continue.
4. Spot-check state: list actions (`ghostapi actions` or the equivalent CLI), run a reconciliation run, and confirm SLO sample counts are non-zero.

## Destroy-The-World Drill (Non-Destructive)

1. `backupRuntime` into `.ghostapi/reliability/backups/drill-<date>`.
2. `Remove-Item -Recurse -Force .ghostapi` (or `rm -rf`) to simulate data loss.
3. `restoreRuntimeBackup` into a fresh directory.
4. Point `GHOSTAPI_DATA_DIR` at the restored directory and run the verification steps above.
5. Confirm the backup directory still exists untouched (restore copies out of it; it never deletes).

## Failure Modes

| Symptom | Meaning | Action |
| --- | --- | --- |
| "Backup destination already exists" | Refusing to overwrite | Use a new destination or remove the old backup deliberately |
| "Backup source entry is not valid JSON" | A `.json` file in the data dir is corrupt | Find and fix/delete the corrupt store, then re-back up |
| "Backup file content changed during copy" | Concurrent write during backup | Stop writers, re-run backup |
| "failed integrity verification" on restore | Backup was tampered or the disk changed | Do not restore; find the original source or a different backup |
| "path escapes its root directory" | Crafted/tampered manifest | Reject the backup as untrusted |
| `/health/readiness` returns 503 | A restored store is corrupt | Inspect the `degraded` store in the report and repair/delete it, then re-check |

## Retention Guidance

- Keep at least two rotating backups: the previous known-good and the current.
- Back up before any release or before switching `GHOSTAPI_DATA_DIR`.
- The 64 MiB backup cap covers the bounded local stores; if your worlds/actions exceed it, prune old synthetic data first.