# GhostAPI Hosted Pilot

This is a separate Bun/Elysia deployment boundary for the hosted pilot. It does not replace the root Node.js local runtime and is not included in the published `@yiaany/ghostapi` package.

## Before Deployment

1. Install Bun 1.3.14 or newer.
2. Run `npm install --package-lock-only --ignore-scripts` after each dependency change and commit `package-lock.json`. The Bun image installs from that reviewed npm lockfile.
3. Use a PostgreSQL connection URL with `search_path=auth` for `AUTH_DATABASE_URL`, then run `bunx auth@latest migrate --config src/auth.ts --yes` against that schema.
4. Apply `migrations/001_core.sql` with a migration role that owns the `app` schema.
5. Provision CI ingest keys through the authenticated `POST /v1/projects/:projectId/ingest-keys` endpoint. It persists only their SHA-256 hashes and returns each plaintext secret exactly once.
6. Configure Fly secrets from `.env.example`. Do not put database, OAuth, QStash, Redis, or ingest credentials in `fly.toml`.

`Dockerfile` copies the reviewed `package-lock.json` before installation. Do not build from an uncommitted dependency change.

## Operational Contract

- `POST /v1/projects/:projectId/reports` returns `202` only after the report, idempotency record, and outbox event commit in one PostgreSQL transaction.
- Retrying the same `Idempotency-Key` and body returns the original report id. Reusing a key with a different body returns `409`.
- Outbox dispatch may publish more than once. QStash deduplication is advisory; `app.job_receipts` remains the durable consumer idempotency ledger.
- Queue messages contain only `{ eventId, reportId, schemaVersion }`, never report payloads or credentials.
- The queue receiver rejects declared or chunked bodies over 16 KiB before JSON parsing or signature verification.
- Writes and read-your-writes use the Postgres primary. A future replica read endpoint must label responses as eventual and never serve a write-after-read contract.

See `../docs/hosted-pilot.md` for load, data, queue, disaster-recovery, and deployment constraints.
