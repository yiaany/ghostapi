# Commercial Metrics Plan

## Boundary

No new product telemetry is introduced by this plan. The implemented `ghostapi telemetry` feature remains local-only, disabled by default, aggregate-only, and has no upload path. See the [telemetry plan](../design-partners/telemetry-plan.md).

This document defines a private, manual founder ledger for decision-making once a prospect or pilot explicitly shares a sanitized signal. It is not a customer analytics system.

## Metrics That Matter

| Metric | Definition | Source | Privacy Rule |
| --- | --- | --- | --- |
| Weekly active teams | Teams with a consented, dated indication of meaningful local or CI use during a calendar week. | Sanitized partner confirmation or approved aggregate. | Store only opaque team ID, week, and source reference. |
| Weekly protected CI workflows | Distinct selected workflows producing supported GhostAPI evidence in a week. | Sanitized partner-provided count. | No repository names, job names, payloads, or workflow logs. |
| Confirmed outcomes | Bugs caught before merge or supported production-egress attempts prevented. | Sanitized closeout or evidence reference. | Store category/date/reference, never raw traffic or secrets. |
| Paid-pilot decisions | Explicit `signed`, `declined`, `deferred`, or `OSS-only` decision. | Buyer decision record. | Store opaque account ID, date, and outcome. |
| Booked pilot value | Contracted fixed pilot fees, excluding unapproved pipeline estimates. | Executed commercial record. | Store amount, currency, period, and opaque pilot ID only. |
| Cash collected | Payments received for signed pilots. | Finance record. | Store invoice ID, amount/currency, date, and opaque pilot ID only. |
| Pilot conversion | Signed paid pilots divided by proposals issued in a defined period. | Commercial ledger. | Count-only reporting. |

## Deliberately Excluded Metrics

- Individual users, seats, source repositories, provider names, commands, traffic, code, prompts, agent content, credential data, customer end-user data, payment-card data, and raw invoice details.
- Auto-collected funnel metrics, cross-device identifiers, session replay, behavioral profiling, and unconsented product analytics.
- Pipeline dollar values presented as revenue, projected ROI, or unverified savings.

## Minimal Private Ledger Schema

Maintain this outside the repository with least-privilege access:

| Field | Rule |
| --- | --- |
| `account_id` | Random opaque identifier; never an email, company name, or repository name. |
| `week_or_date` | ISO week or ISO date needed for the metric. |
| `signal_type` | Allowlisted metric name from this document. |
| `outcome` | Allowlisted value such as `signed`, `declined`, `deferred`, or `confirmed_bug_caught`. |
| `amount` and `currency` | Present only for signed invoices or received payments. |
| `source_reference` | Internal sanitized note or commercial-record reference, not raw content. |
| `retention_review_date` | Date on which the record is reviewed under legal/privacy requirements. |

## Reporting Rules

1. Report counts and signed/collected amounts separately.
2. Label every metric as observed, target, or hypothesis.
3. Do not report a retention, conversion, or ROI figure without its denominator and a dated source period.
4. Do not treat an OSS download, demo, installation, or polite pricing response as a paying-customer signal.
5. Reconcile booked value and cash collected with the approved finance system before any board, investor, or public statement.

## Review Trigger

Revisit the metric design only if a design partner explicitly requests hosted reporting or a validated paid workflow requires it. Any networked or account-level telemetry needs a new opt-in, schema, data-retention decision, threat model, and legal review.
