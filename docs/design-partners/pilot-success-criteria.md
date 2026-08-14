# Pilot Success Criteria

Agree on the rows below before setup. A successful pilot needs more than installation.

| Dimension | Minimum measurable signal | Source of truth |
| --- | --- | --- |
| Activation | A team completes `init`, configures one policy/scenario, and produces a valid local or CI evidence artifact. | Sanitized artifact hash and dated owner confirmation. |
| Regular CI use | At least one selected workflow runs in CI weekly for two consecutive weeks. | CI run links or sanitized run-count export. |
| Enforcement value | The team can explain a merge/release decision changed by egress enforcement or evidence. | Buyer/developer closeout note. |
| Defect value | At least one real integration defect is caught before merge, or a documented absence of defects after exercising agreed failure paths. | Sanitized issue/PR reference and reproduction summary. |
| Willingness to pay | The buyer states a budget range, paid-pilot decision, or LOI decision with a date. | Pricing interview summary. |

## Guardrails

- A synthetic demo alone does not count as a real bug caught.
- An installed CLI without repeated CI use does not count as retention.
- A product claim without a dated source record does not satisfy this table.
- Do not claim prevented production egress unless the supported enforcement evidence proves the relevant run.

## Exit Decisions

| Outcome | Decision |
| --- | --- |
| Weekly CI use plus real buyer value | Continue the narrow CI/shared-scenario product path and offer paid pilot terms. |
| Strong local value but CI blocker | Fix only the blocker proven across partners; do not expand general cloud scope. |
| No recurring pain or no buyer | Stop/reshape the wedge before building billing or enterprise control-plane features. |
| Security/platform mismatch | Document the limitation and qualify a different environment; do not overclaim enforcement. |
