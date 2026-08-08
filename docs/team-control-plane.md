# Team Control-Plane Prototype

## Scope Gate

As of August 8, 2026, GhostAPI has no recorded active-project count and no CI or paying design partner. The team-control-plane gate is therefore not met. This release is a local architecture prototype and a design-partner onboarding workflow, not a hosted cloud product.

It does not start a network service, add login to the local runtime, synchronize data, upload traffic, upload code, or render a speculative team dashboard. `ghostapi start`, local provider simulation, worlds, record/replay, and local CLI workflows remain usable without an account or token.

## Tenant Model

The prototype persists one private, local JSON store at `.ghostapi/team-control-plane.json` (or the configured `GHOSTAPI_DATA_DIR`). It models:

| Entity | Isolation rule |
| --- | --- |
| Organization | Root tenant boundary. |
| Member | Belongs to exactly one organization. Roles are `owner`, `admin`, and `member`. |
| Project | Belongs to one organization. Project ids are resolved only inside the caller's organization. |
| Environment | Belongs to one project and organization. Supported kinds are `development` and `ci`. |
| Scenario version | Bound to an organization, project, and environment. Same scenario/version cannot be duplicated in that scope. |
| Evidence summary | Bound to an organization, project, and environment. Only sanitized, hash-validated evidence metadata is stored. |
| Policy version | Bound to an organization and distributed by an owner or admin. |
| Token | Bound to one organization/member and stored only as a SHA-256 digest. |
| Audit record | Bound to an organization and records actor, action, resource, and timestamp. |

All reads re-check organization membership and parent relationships. Cross-tenant identifiers return `Resource not found` where a scoped resource is absent, rather than disclosing another tenant's data.

## Prototype API

The supported surface is the typed local library exported from `@yiaany/ghostapi`:

```ts
import { createLocalTeamControlPlane } from "@yiaany/ghostapi";

const team = createLocalTeamControlPlane();
const owner = { organizationId: "acme", memberId: "owner" };

await team.bootstrapOrganization({ organizationId: "acme", name: "Acme", ownerId: "owner" });
await team.registerProject(owner, { projectId: "payments", name: "Payments" });
await team.createEnvironment(owner, { environmentId: "payments-ci", projectId: "payments", name: "CI", kind: "ci" });
await team.publishScenario(owner, {
  projectId: "payments",
  environmentId: "payments-ci",
  scenarioId: "retry-flow",
  version: 1,
  title: "Retry flow",
  metadata: { provider: "stripe", review: "required" }
});
```

The API also supports `uploadSanitizedEvidence`, `distributePolicy`, `issueToken`, `revokeToken`, scoped listing methods, `listAudit`, and `pruneRetention`.

## Evidence And Privacy

`uploadSanitizedEvidence` accepts only an existing GhostAPI evidence-report schema with a valid logical hash. It rejects artifacts larger than 512 KiB, raw authorization/cookie/raw-body fields, and secret-shaped values. The control-plane store retains a narrow projection only: report hash, run status, summary counts, provider/scenario ids, and enforcement status. It never persists raw traffic, source code, request or response bodies, command arguments, environment variables, or provider credentials.

Scenario metadata and policy payloads are bounded, JSON-only, depth-limited, and reject secret-shaped fields and values. This prototype does not accept arbitrary files or archives.

## Tokens

Owners and admins can issue a token for an existing member with an explicit expiry no more than 90 days in the future. Tokens begin with `gapi_team_`, are returned once by `issueToken`, and are stored only as SHA-256 digests. `authenticateToken` rechecks expiry, revocation, and current membership. `revokeToken` invalidates the token immediately for the next authentication attempt.

This is local client-side storage, not a cloud credential broker. Treat the returned token like any local development credential and keep the data directory private. Do not put it in scenarios, evidence, repository files, or CI logs.

## Persistence, Migration, And Retention

The store uses the existing same-directory atomic JSON replacement and cross-process file lock. It rejects symlink store paths and limits the store to 1 MiB. Schema v1 is migrated in memory to schema v2 by adding an empty audit ledger; migrated state must then pass complete tenant-reference validation before it is used or rewritten.

Retention runs on writes and can be invoked explicitly with `pruneRetention`:

| Data | Retention |
| --- | --- |
| Sanitized evidence summaries | 30 days and 100 records per organization |
| Audit metadata | 90 days and 1,000 records per organization |

Retention is local and best-effort for this prototype. It is not immutable audit storage, legal hold, backup management, or a distributed database guarantee.

## Design-Partner Onboarding

Use this workflow only with a team that has explicitly confirmed a need for shared scenario metadata or CI history:

1. Confirm the concrete workflow: shared scenario review, CI evidence retention, or team policy distribution.
2. Run the local GhostAPI workflow first. The design partner must not need a cloud account for daily local simulation.
3. Create one local organization/project/environment prototype and import only a generated sanitized evidence report.
4. Review the projected stored data with the partner. Confirm that no raw traffic, code, secrets, or PII are required for their workflow.
5. Collect the required hosted workflow, access model, retention duration, and CI provider. Do not infer a dashboard or integration from a single interview.
6. Promote this prototype to a hosted MVP only after the gate is met: at least three active projects or one design partner confirming shared scenarios/CI history.

## Deployment And Runbook

There is no deployment for this prototype. It is a local library and has no listener, external dependency, database, background worker, telemetry, or cloud sync job.

Operational checks:

```bash
npm run typecheck
npm test -- --run test/teamControl.test.ts
npm run build
```

If the store is malformed, oversized, or a symlink, the library fails closed. Restore it only from a reviewed local backup; do not bypass validation or manually merge tenant records. If a token is suspected to be exposed, call `revokeToken` with an owner/admin actor, remove the exposed value from logs or CI, then issue a replacement with the shortest suitable expiry.

## Explicit Non-Goals

- No hosted API, web UI, cloud synchronization, billing, SSO, SCIM, or generic project management.
- No raw traffic/code/secret upload or automatic upload of any artifact.
- No replacement for the local-first GhostAPI runtime.
- No claim of distributed isolation, tamper-evident audit storage, production credential brokering, or enterprise compliance.
