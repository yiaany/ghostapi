# Draft Data Inventory For Legal Review

> **Draft only.** This inventory describes observed local-product behavior and proposed commercial categories as of August 8, 2026. It must be validated by engineering, operations, and qualified counsel before any hosted or paid service launches.

## Current Local Runtime

| Data category | Purpose | Location | Default sharing | Retention boundary |
| --- | --- | --- | --- | --- |
| Local simulation state, scenarios, and contracts | Run deterministic local provider simulations and replays. | Operator-controlled `.ghostapi/` data directory. | None by GhostAPI. | Local files; documented bounded stores apply where implemented. |
| Local events and evidence reports | Inspect local requests and generate sanitized CI evidence. | Operator-controlled `.ghostapi/` data directory. | None by GhostAPI. | Events/reports have documented local size/count retention. |
| Local dashboard/MCP inputs | Display and control the operator's local runtime. | Process memory and operator-controlled local files where applicable. | None by GhostAPI. | Controlled by process lifetime and local retention behavior. |
| Optional local telemetry aggregate | Measure local activation/recurrence only after explicit opt-in. | `.ghostapi/product-telemetry.json`. | No upload path. | Deleted by `ghostapi telemetry disable`; bounded while enabled. |

The local tool can process data supplied by the operator, including values that may be sensitive. Secret masking and sanitization reduce exposure but are not a guarantee of complete redaction. Operators should not direct live production traffic or credentials to GhostAPI.

## Proposed Pilot And Commercial Records

| Data category | Purpose | Proposed storage boundary | Prohibited content |
| --- | --- | --- | --- |
| Business contact and contracting details | Execute a signed pilot and communicate operationally. | Approved business/contract system, separate from product data. | Source code, traffic, credentials, payment-card data. |
| Invoice/payment-status metadata | Issue and reconcile a fixed pilot invoice. | Approved accounting/invoicing system. | Card number, CVC, bank-login credentials, raw payment instrument data. |
| Sanitized pilot outcome summary | Measure agreed success criteria and close out the pilot. | Access-controlled commercial record. | Raw evidence, logs, requests, prompts, end-user data, secrets. |
| Opaque commercial metrics | Track counted outcomes and signed/collected pilot value. | Access-controlled private ledger. | Names, emails, repository/provider names, raw invoice data, telemetry identifiers. |

## Proposed Hosted Pilot Data

The hosted architecture is not deployed. If it is launched after the design-partner gate is met, update this inventory with actual collection, schema, processor, deployment region, access controls, retention, backups, deletion/export mechanics, and incident-response evidence before onboarding a customer.

The architecture currently proposes bounded sanitized CI report payloads, immutable scenario versions, organization/membership metadata, scoped ingest-key digests, idempotency records, job receipts, and audit metadata. It must not accept raw credentials, authorization headers, cookies, raw traffic, source code, or payment data.

## Access And Review

- Local files are controlled by the operator's local filesystem permissions and data directory.
- Commercial records require least-privilege finance/legal access and a documented retention review date.
- Any future hosted roles, tenant isolation, backups, exports, and processors require implementation evidence and counsel review before claims are made.
- Review this inventory after every new collection path, telemetry proposal, processor, billing system, provider integration, or retention change.
