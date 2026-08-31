# Agent Inventory And Attack-Path Graph Threat Model

Applies to the local agent inventory layer: the persisted inventory store, attack-path graph, blast-radius analysis, detections, remediation workflow, open export, removal analysis, and ROI report.

## Scope

This threat model covers the inventory module added in the "agent inventory, attack-path graph, and indispensability" session:

- `inventory.json` local persisted store under `.ghostapi/`, created by `getDataPaths().inventoryStore`.
- Import of agents, tools, identities, providers, resources, side effects, credentials, and policies from `config`, `ci`, `gateway`, and `cloud` sources, each record carrying provenance (source, import time, importer) and freshness.
- The attack-path graph (`agent -> identity -> tool -> provider -> resource -> side effect`) with persisted, provenance- and freshness-carrying edges.
- Blast-radius analysis, detections, remediation proposals/applications, open export, removal analysis, and the ROI report.

The inventory layer adds no provider, credential, network egress, or hosted control-plane surface. All of it is local-first and synthetic. ROI and removal numbers are derived from imported counters and local records only; nothing is invented, and the pilot entry gate (a real team/enterprise pilot) is not yet met.

## Trust Boundaries

| Boundary          | In scope                                                                                                                                                                                                                                                                          | Out of scope                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Operator identity | Every inventory action authenticates through an injectable authorizer and requires an explicit permission (`inventory.import` / `inventory.inspect` / `inventory.analyze` / `inventory.remediate` / `inventory.export`); the test authorizer binds issued identities by reference | Real authn/authz infrastructure                                          |
| Import sources    | Imports declare a source (`config` / `ci` / `gateway` / `cloud`) that is recorded as provenance on every record and edge                                                                                                                                                          | Live provider or CI credentials; the layer never reaches out to a source |
| Tenant isolation  | All reads and writes are filtered by `tenantId`; graph, findings, export, attack paths, removal, and ROI are tenant-scoped                                                                                                                                                        | Multi-tenant federation                                                  |
| Store             | Regular non-symlink JSON file, owner-only on POSIX, bounded bytes and record counts                                                                                                                                                                                               | Remote/distributed storage                                               |

## Assets

- Agent inventory records and graph edges (`inventory.json`).
- Provenance and freshness metadata attached to every record and edge.
- Findings and remediation state (proposals, applications, rejections).
- The open export artifact (inventory, policies, eval scenario references, evidence metadata, removal analysis, ROI).
- Import-run and import-source ledger.

## Threats And Mitigations

### T1. Unauthenticated or unauthorized inventory writes

Every mutating and reading method calls `authorize` first: `validateOperator` on the authorizer result and an explicit permission check. The default authorizer (`createDisabledInventoryOperatorAuthorizer`) throws "not configured", so a controller with no authorizer cannot be used. Test identities are reference-bound; a plain `{}` is rejected as "not authenticated".

### T2. A poisoned import poisons the graph

`validateImportPayload` enforces strict schema, allowed source types, identifier/scope/hash/timestamp formats, bounded array sizes, and per-kind id uniqueness before anything is stored. Cross-references (e.g. an agent referencing an unknown identity) are validated against both the current import and the persisted state, and a reference to a record that does not exist rejects the whole import. Import payloads are canonicalized to a digest recorded on the import run and source.

### T3. Tenant data leaks across the graph or export

Every graph edge, record, finding, remediation, import run, and source is filtered by `operator.tenantId` in `snapshotFor`, `graphEdges`, `findAttackPaths`, `computeBlastRadius`, `computeFindings`, `computeCoverage`, `computeRemovalAnalysis`, `computeRoiReport`, and `export`. An edge can only be created from a record that belongs to the importing tenant. Cross-tenant leakage is covered by tests.

### T4. Provenance or freshness is missing or forged

Every record and edge carries `provenance` (`sourceId`, `sourceType`, `sourceName`, `importedAt`, `importedBy`) and `freshness` (`firstSeenAt`, `lastSeenAt`) built from the import payload source and the authenticated operator's principal id — never from client-supplied strings. `validateState` re-validates provenance/freshness on every read and write. Edge ids are derived from source/target/relation so re-imports refresh `lastSeenAt` instead of duplicating edges.

Edges have a freshness lifecycle. Attack-path and blast-radius analysis only use edges whose `lastSeenAt` is within the configured `edgeStaleDays` window, so a long-unseen relationship cannot be cited as current reachability evidence. On every import the importing tenant's stale edges are garbage-collected from the store, keeping the graph from accumulating frozen relationships that were never refreshed.

### T5. A remediation expands permissions instead of reducing them

`reduce_scope` proposals are rejected at proposal time unless the reduced scope list is a strict subset of the credential's current grant scopes and removes at least one scope; the same invariant is enforced again at apply time. `revoke` only ever sets a credential to revoked. `assign_owner` only sets an owner id. `onboard_through_gateway` only sets the gateway-managed flag. `create_eval` only records an eval scenario reference — and, when an `evalScenarioExists` resolver is configured, the referenced scenario must actually exist before the proposal is accepted, so a remediation cannot paper over a finding by pointing at a deleted scenario. No remediation path adds scopes or relaxes a control.

Applied remediations are re-verified on every analysis pass: a finding stays resolved only while the remediation remains effective. If a later import re-expands a reduced scope, revokes nothing, clears an assigned owner, un-gates an agent, or deletes the referenced eval scenario, the finding is re-opened instead of staying permanently marked resolved.

Remediation targets are validated against the tenant's live data before a proposal is accepted: an `environment` target must actually be referenced by at least one agent, identity, provider, resource, credential, or policy of the tenant, so a remediation cannot be proposed against a stale or invented environment.

### T6. The store is poisoned or exploded

The store is validated on every read (`validateState`) and write (`atomicWriteJson(this.path, validateState(state))`). Store bytes are capped at 8 MiB; every collection is bounded (`maxAgents`, `maxEdges` 6,000, `maxFindings` 3,000, etc.), and `assertStoreBounds` rejects edges and findings over their caps on every mutation. Import runs are rotated per tenant at `maxImports` (256), keeping the oldest runs trimmed rather than failing the write. The store must be a regular non-symlink file. Oversized or non-JSON stores are rejected, not partially loaded.

### T7. Secret-shaped or control-character data enters the inventory

Identifiers, scopes, and text are validated by regexes and by `sanitizeSecretString`: any value that contains a recognizable secret shape (e.g. `sk_live_*`) or control characters is rejected. Evidence metadata and reasons are bounded text.

### T8. ROI or removal analysis invents savings

The ROI report is built only from imported counters (latest per source) and from actually applied remediations in the store; unmeasured counters are reported as `null` and listed in `notMeasured`, and `basis` is `local_inventory_data_only`. The removal analysis reports only numbers computed from the local store and states plainly when nothing verifiable depends on GhostAPI. The heuristic blast-radius classification is explicitly labeled advisory, not proof of exploitability.

### T9. Attack-path graph is unbounded or cross-tenant

Edges are created only from the importing tenant's records, are keyed by a derived edge id, and are bounded (`maxEdges` 6,000). Path finding is always scoped to the tenant and to a single agent id. Incomplete paths (a record reference missing from the store) are counted separately and reported as incomplete, not silently dropped.

## Permissions And Capabilities Summary

| Action                                                            | Check                                       |
| ----------------------------------------------------------------- | ------------------------------------------- |
| Import                                                            | operator authorizer + `inventory.import`    |
| Inspect / graph / attack paths / blast radius / list remediations | operator authorizer + `inventory.inspect`   |
| Analyze / removal analysis / ROI                                  | operator authorizer + `inventory.analyze`   |
| Propose / apply / reject remediations                             | operator authorizer + `inventory.remediate` |
| Export                                                            | operator authorizer + `inventory.export`    |

## Limits

| Resource                             | Limit               |
| ------------------------------------ | ------------------- |
| Store bytes                          | 8 MiB               |
| Import sources / import runs         | 64 / 256            |
| Agents / tools / identities          | 500 / 500 / 500     |
| Providers / resources / side effects | 200 / 1,000 / 2,000 |
| Credentials / policies               | 500 / 100           |
| Graph edges                          | 6,000               |
| Findings / remediations              | 3,000 / 1,000       |
| References / scopes per record       | 64 / 32             |

## Out Of Scope

- Live provider, CI, or gateway ingestion (the layer consumes locally-supplied payloads only).
- Hosted multi-tenant control plane and federated sources.
- Automated kill-switch or revocation execution against real providers (remediations mutate the local inventory state only).
