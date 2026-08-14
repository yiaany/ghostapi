# Data Room Checklist

Create this room only with founder and counsel review. Do not place provider secrets, raw traffic, production credentials, customer source code, personal data, or unredacted security incidents in it.

## Corporate

- [ ] Certificate of incorporation or formation; jurisdiction and entity type.
- [ ] Charter, bylaws, operating agreement, and board consents.
- [ ] Cap table with fully diluted ownership, option pool, SAFEs/notes/warrants, and dates.
- [ ] Founder stock purchase agreements and vesting/repurchase terms.
- [ ] Founder, employee, and contractor IP/confidentiality assignment agreements.
- [ ] Current officer/director list and any investor rights.
- [ ] Tax registrations, elections, and material tax correspondence.

## Product And IP

- [ ] Repository map, architecture overview, and package boundaries.
- [ ] License inventory for direct and material transitive dependencies.
- [ ] OSS license, contributor policy, and third-party notices.
- [ ] Trademark/domain ownership record, if applicable.
- [ ] Evidence that contributors assigned or licensed contributed IP appropriately.
- [ ] List of proprietary datasets, provider contracts, or generated assets, if any.

## Security And Privacy

- [ ] `SECURITY.md`, egress threat model, release-readiness matrix, and incident-response material.
- [ ] Current dependency audit results with runtime/dev separation and remediation plan.
- [ ] Secure-development controls: code review, CI, pinned actions, secret scanning, and release checklist.
- [ ] Data inventory and draft privacy/terms materials clearly labeled as non-operative until counsel approves them.
- [ ] Product data-flow diagram: local runtime, local evidence, optional local telemetry, and undeployed hosted-pilot boundary.
- [ ] Disclosure of limitations: Linux-only enforcement, same-user/filesystem limits, heuristic sanitization, and no deployed hosted control plane.
- [ ] Penetration-test, SOC 2, ISO, or compliance evidence only if actually completed; otherwise state "not completed."

## Commercial And Customer Evidence

- [ ] Dated, sanitized customer discovery ledger with source references.
- [ ] Signed pilot agreements, LOIs, invoices, purchase orders, or renewals, if any.
- [ ] Pilot success criteria and closeout reports.
- [ ] Customer references only with written permission.
- [ ] Pricing hypotheses, quotes, objections, and conversion outcomes marked as observed vs assumption.
- [ ] Explicit statement that as of 2026-08-09 this repository contains no verified paid pilot, LOI, customer outcome, or revenue.

## Metrics

- [ ] Metric definitions: activation, weekly CI use, retained team, prevented egress, bug caught, paid pilot, and expansion.
- [ ] Data-source map and owner for each metric.
- [ ] Local telemetry export policy and opt-in/opt-out evidence.
- [ ] Cohort and retention reports only after data is actually collected.
- [ ] Explanation of metrics unavailable or not measured; never backfill estimates as observed facts.

## Financial Model Inputs

- [ ] Cash balance, burn, runway, headcount/contractor commitments, and material liabilities.
- [ ] Bottom-up pilot model: target accounts, discovery-to-pilot assumptions, fixed pilot scope, support hours, and delivery cost.
- [ ] Pricing research ledger, including null/negative outcomes.
- [ ] Hosting, support, provider, security, legal, insurance, and sales cost assumptions with date/source.
- [ ] Base, downside, and upside scenarios clearly labeled as assumptions.
- [ ] No claim of ARR, MRR, gross margin, CAC, LTV, or pipeline without a source and calculation.

## Contracts And Legal

- [ ] Pilot agreement template reviewed by counsel.
- [ ] Statement of work template: scope, evidence, support boundary, acceptance, confidentiality, and exit.
- [ ] Data-processing terms, subprocessors, retention/deletion terms, and security addendum only when the service model exists and counsel approves them.
- [ ] Insurance, export-control, employment, and open-source compliance records as applicable.

## Technical Due Diligence

- [ ] Link to [technical-due-diligence-index.md](technical-due-diligence-index.md).
- [ ] Release commit SHA and CI evidence from the exact release candidate.
- [ ] Test/build/package/audit outputs with command, date, environment, and known gaps.
- [ ] Architecture decisions, threat model, security findings, and remediation status.
