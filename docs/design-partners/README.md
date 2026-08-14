# Design-Partner Validation

This directory is the working kit for validating whether GhostAPI solves an expensive enough problem before more cloud, enterprise, or billing scope is built.

## Evidence Status: August 8, 2026

### Facts

- The local runtime, CI evidence model, deterministic evals, and team-control-plane prototype exist in this repository and have automated coverage.
- `SESSION_LOG.md` records `0` CI design partners and `0` paying design partners as of August 4, 2026.
- The repository contains no interview transcript, named customer record, weekly CI evidence, bug report from a user, LOI, paid pilot, or willingness-to-pay result.
- Existing README text previously asserted that a design partner confirmed a workflow need, but this repository has no primary source that independently verifies that assertion. Treat it as an unverified prior note, not demand evidence.

### Hypotheses To Test

- Teams using coding agents fear accidental production egress and lack proof that CI did not touch production.
- Payment, webhook, and retry failures are painful enough that teams will add GhostAPI to merge-gating CI.
- Platform, AppSec, and developer-productivity buyers value enforcement evidence more than another mock server.
- A team that catches a real integration defect or blocks real egress will pay for enforced CI evidence and shared workflow controls.

### Targets, Not Results

- Three teams use GhostAPI weekly.
- One design partner runs GhostAPI in CI.
- One user confirms a real bug was caught before merge or a production egress attempt was prevented.
- One company agrees to a paid pilot or signs a specific LOI.

## Gate

Do not expand cloud/enterprise scope based on this documentation alone. Continue the larger scope only after at least one target above is supported by a dated, sanitized source record. Store a summary, not source code, traffic, credentials, personal data, or raw interview recordings.

## Kit

- [ICP one-pager](icp-one-pager.md)
- [Discovery questions](discovery-questions.md)
- [Design-partner offer](design-partner-offer.md)
- [Pilot success criteria](pilot-success-criteria.md)
- [Onboarding checklist](onboarding-checklist.md)
- [Feedback capture template](feedback-capture-template.md)
- [Pricing interview script](pricing-interview-script.md)
- [Privacy-first telemetry plan](telemetry-plan.md)
- [Demo narratives](demo-narratives.md)

## Evidence Ledger

For every real conversation or pilot signal, add one sanitized row outside the public repository or in a private founder log:

| Date | Team segment | Role | Signal | Evidence location | Next action |
| --- | --- | --- | --- | --- | --- |
| YYYY-MM-DD | e.g. B2B SaaS, 20-80 engineers | e.g. Platform lead | Interview / CI run / bug caught / LOI / paid pilot | Private sanitized note ID | Concrete follow-up |

Do not fill this table with prospects, assumptions, or fabricated outcomes.
