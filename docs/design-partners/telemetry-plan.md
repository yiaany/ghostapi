# Privacy-First Product Telemetry Plan

## Principles

- Collection is off by default and requires `ghostapi telemetry enable` on the local machine.
- The implementation has no network transport, endpoint, cloud account, automatic upload, or background process.
- It never records source code, prompts, commands, request/response traffic, URLs, provider names, credentials, tokens, personal data, repository identity, machine identity, or full timestamps beyond local aggregate activity timing.
- `ghostapi telemetry disable` deletes the local aggregate. Users can inspect it at any time with `status` or `export`.

## Local Implementation

The bounded aggregate is stored at `.ghostapi/product-telemetry.json` (or `GHOSTAPI_DATA_DIR`) with owner-only permissions on POSIX. It contains four integer counters, up to eight ISO week labels, and optional activation/last-activity timestamps. Atomic writes and a local file lock prevent lost updates between cooperating GhostAPI processes. Malformed or unknown-field data fails closed, and a telemetry file observed as a symlink is rejected. This local store is not a security boundary against a same-user attacker able to race filesystem operations.

```bash
ghostapi telemetry status
ghostapi telemetry enable
ghostapi telemetry export --json
ghostapi telemetry disable
```

`export` is a local JSON print operation, not an upload feature. If a partner chooses to share a result, they should review and transfer only the exported aggregate through an approved channel.

## Event Schema

| Event | Recorded only after opt-in | Why |
| --- | --- | --- |
| `init_completed` | Incrementing count | Measures setup starts, not activation. |
| `enforced_run_completed` | Incrementing count and first activation time | Measures completion of the supported enforcement workflow. |
| `evidence_generated` | Incrementing count and first activation time | Measures evidence creation, the earliest useful product outcome. |
| `eval_completed` | Incrementing count | Measures recurring verification behavior. |

## Metrics

| Metric | Definition | Interpretation |
| --- | --- | --- |
| Activation | At least one `enforced_run_completed` or `evidence_generated` event. | A user reached a meaningful safety/evidence result. |
| Weekly active local project | At least one tracked event in an ISO week. | Directional local engagement only; it does not identify a team. |
| Four-week retention | At least two active weeks separated by 21+ days. | Requires partner-shared aggregate or another consented evidence source. |
| CI retention | Repeated selected CI workflow runs weekly. | Must come from a partner's sanitized CI evidence; the local counter does not prove CI. |

## What Is Deliberately Not Measured Yet

- Users, companies, seats, repositories, agents, providers, commands, source files, traffic, errors, exact scenario names, runtime duration, revenue, or raw defect details.
- Any server-side metric, cross-device identity, attribution, or automatic product analytics.

## Review Trigger

Revisit the plan only when a design partner explicitly asks for aggregate sharing or hosted reporting. Any networked telemetry proposal requires a new opt-in, schema review, data-retention policy, threat model, and explicit customer approval.
