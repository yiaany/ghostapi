# Design-Partner Onboarding Checklist

## Before Kickoff

- [ ] Confirm the partner has authorized the named technical contact and repository experiment.
- [ ] Select one integration, one failure mode, and one merge/release workflow.
- [ ] Confirm no production credentials, code, raw traffic, customer data, or incident exports will be sent to GhostAPI.
- [ ] Confirm a supported Linux CI runner is available if enforcement evidence is required.
- [ ] State the success criterion, decision owner, and pilot end date.

## Setup

- [ ] Run `ghostapi doctor --json` and save only the non-sensitive capability result.
- [ ] Create or review `ghostapi.policy.yaml`; default external network access remains denied.
- [ ] Use fake/local credentials and provider-shaped local endpoints.
- [ ] Choose one deterministic scenario: egress block, duplicate payment, or webhook signature validation.
- [ ] Run the selected test locally and create one sanitized evidence artifact.
- [ ] Add the CI job only after the local artifact is understood.

## Weekly Review

- [ ] Count the selected CI runs without uploading CI logs or payloads.
- [ ] Record whether the agreed scenario ran and whether the evidence changed a review decision.
- [ ] Capture a sanitized bug/egress outcome, if any.
- [ ] Ask the buyer whether the current evidence is worth paying for and why.
- [ ] Record one blocker, owner, and due date; avoid open-ended feature requests.

## Closeout

- [ ] Score the criteria in `pilot-success-criteria.md` from evidence.
- [ ] Separate observed facts from user opinions and founder hypotheses.
- [ ] Capture a paid-pilot / LOI / no-decision outcome and date.
- [ ] Delete any local pilot notes that contain unnecessary sensitive data.
