# GhostAPI Hosted Pilot

This directory is the independent Bun/Elysia hosted deployment boundary. It does not alter or ship the root local runtime.

## Reproducible Build

1. Use Bun 1.3.14 and Node 20.19 or newer.
2. Change dependencies only in `package.json`, run `npm install --package-lock-only --ignore-scripts`, review `package-lock.json`, then run `npm ci --ignore-scripts`.
3. Run `npm run check` and `npm audit --audit-level=low` before deployment.
4. The Docker build runs the same frozen `npm ci`, typecheck, tests, and Bun build. The runtime image contains production dependencies only and runs as the `bun` user.

## Database

Apply `migrations/001_core.sql`, `migrations/002_production_hardening.sql`, `migrations/003_remaining_hardening.sql`, then `migrations/004_organization_creation_quota.sql`, using the schema owner. Run the pinned `npm run auth:migrate` separately against `AUTH_DATABASE_URL` configured with `search_path=auth`.

`DATABASE_URL` is intentionally a service-role connection. RLS prevents accidental access by other roles, but the service role can access every tenant. Therefore application authorization is mandatory: all user-facing resource queries join or first query `organization_memberships`, use parameterized SQL, return tenant-safe `404` responses for cross-tenant resources, and are covered by hosted HTTP authorization/IDOR tests. Never expose the service-role credential to clients or use it from browser code.

The forward migrations add invitation records, ingest-key metadata, worker failure/dead-letter fields, durable tenant and per-user organization quotas, deferred owner preservation, bounded scenario constraints, audit metadata, and retention indexes without rewriting deployed migrations.

## Authentication And Roles

Better Auth uses a seven-day session, daily rotation, a ten-minute freshness window, secure prefixed cookies, disabled account linking, and the exact HTTPS origins in `HOSTED_ALLOWED_ORIGINS`. Hosted mutation APIs require a matching `Origin`; CORS does not reflect arbitrary origins. Responses include HSTS, CSP, anti-framing, MIME-sniffing, referrer, permissions, and no-store headers.

Roles are ordered `owner > admin > developer > viewer`:

- Owner: manage all members, transfer ownership, invite admins, and perform lower-role operations.
- Admin: create projects, manage developer/viewer members, and invite developer/viewer members.
- Developer: create scenarios and create/list/rotate/revoke project ingest keys.
- Viewer: read project scenarios and reports in organizations where they are a member.

Organization creation is IP-rate-limited before authentication, durably capped per user, and makes the authenticated user owner. Invitation tokens are returned only at creation, stored only as SHA-256 hashes, bound to the invited account email, expire, and cannot grant owner directly.

## Reports And Jobs

All mutation bodies are capped at 1 MiB before parsing, including chunked requests. JSON APIs use smaller limits, scenarios use 300 KiB request/256 KiB definition limits, reports stream at most 512 KiB, and queue callbacks stream at most 16 KiB before signature verification.

The worker loads the latest version of each project scenario. A bounded definition may contain `when`, a map of dot paths to exact values, and `assertions`, entries with `path` plus exactly one of `equals` or `exists: true`. Legacy malformed scenarios are isolated as `not-run`; QStash publication requests exactly `WORKER_MAX_ATTEMPTS - 1` retries so every retryable delivery can reach the durable terminal `dead_letter` transition. Outbox publication independently uses leases, exponential retry delay, and `OUTBOX_MAX_ATTEMPTS`.

Organization quota rows durably cap projects, members, active invitations, scenario versions, active ingest keys, and retained reports. A separate locked per-user row caps organizations created by each user. Role-gated mutations lock the organization and re-read the actor's current role in the same transaction before writing, preventing concurrent revocation from racing a stale authorization decision.

Ingest-key list responses contain only id, name, prefix, scopes, timestamps, and last use. Plaintext secrets are returned once on create/rotation and are never persisted or returned later. Create, rotate, and revoke actions are audited.

## Operations

- `npm start`: API server with graceful SIGINT/SIGTERM shutdown.
- `npm run dispatcher`: outbox dispatcher with graceful drain.
- `npm run cleanup`: one-shot retention cleanup for completed/failed reports, expired idempotency rows, old outbox events/job receipts/invitations, and audit data. Schedule it externally at least daily.
- `/healthz`: process liveness only.
- `/readyz`: checks primary DB, auth DB, Redis, and dispatcher/callback configuration. It returns `503` when a dependency is unavailable.

Set all values from `.env.example` as deployment secrets except non-secret limits. Keep the API and QStash callback on the same configured public origin.
