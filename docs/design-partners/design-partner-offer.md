# Design-Partner Offer

## Offer

GhostAPI will work with a small number of teams to prove one high-risk AI-assisted integration workflow before merge. The pilot focuses on a real buyer outcome: evidence that a chosen CI run did not reach production and that a specific failure path is exercised deterministically.

## What The Partner Contributes

- One repository and one non-production integration workflow.
- A technical owner who can run a local or Linux CI experiment weekly.
- A buyer-side stakeholder for a 30-minute kickoff, weekly feedback, and a closeout decision.
- Sanitized evidence of outcome only. No production credentials, raw traffic, proprietary code, or customer data are required.

## What GhostAPI Contributes

- Local-first setup for the selected workflow.
- A reviewed policy and deterministic scenario for one concrete risk.
- A CI evidence artifact and a small closeout report based on observed runs.
- Direct implementation support for agreed pilot blockers within the stated product boundary.

## Explicit Boundaries

- GhostAPI is not a guarantee of complete host isolation, provider parity, or production compliance.
- `ghostapi run` enforcement requires supported Linux namespace preflight; Windows and macOS do not receive an equivalent guarantee.
- No automatic telemetry, cloud upload, raw traffic collection, or source-code transfer is part of the pilot.
- The pilot does not authorize production actions or require production credentials.

## Suggested Timeline

| Phase | Target | Evidence |
| --- | --- | --- |
| Kickoff | Week 0 | Selected repository, risk, owner, baseline workflow. |
| First result | Week 1 | Local deterministic scenario and a reviewed evidence artifact. |
| CI validation | Week 2 | Repeated CI runs or a documented blocker with owner/date. |
| Closeout | Week 3-4 | Measured criteria, buyer decision, and willingness-to-pay interview. |

## Ask

If the pilot proves a recurring release-risk reduction, agree to a paid-pilot discussion or a specific LOI decision at closeout. This is a request for a decision based on evidence, not a promise that the result already exists.
