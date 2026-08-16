# Kill Switch Runbook

## Detection

Use this procedure when policy violations, abnormal action velocity, budget exhaustion, reconciliation mismatch, latency/failure circuit opening, or suspected agent compromise is observed. An alert is evidence only; it is not a stop. Verify the affected organization, project, environment, agent/workload, provider, operation, or risk class before selecting scope.

## Stop

1. Use an independently authenticated emergency operator with `safety.stop`.
2. Call the local `LocalSafetyController.stop({ identity, scope, reason })` API with the narrowest safe scope. Use `global` when the scope cannot be established quickly.
3. Record a bounded factual reason without credentials, raw requests, personal data, or provider payloads.
4. Confirm the persisted switch is enabled and examine the safety audit chain. Matching queued records must be in the dead-letter queue, not still pending.
5. Treat actions that passed their final commit check as potentially completed. Do not retry unknown outcomes; investigate or reconcile them first.

## Investigation

1. Preserve the local safety, action, approval, and credential-broker state files as evidence under the existing local trust model.
2. Inspect action receipt status, controller audit records, budget ledger, circuit reason, and dead letters.
3. Identify the exact idempotency key and action hash. A changed action must be submitted as a new reviewed action, never forced through a prior reservation.
4. For any future provider integration, reconcile against the provider before retrying or compensating. This local synthetic controller cannot prove external outcome.

## Recovery

1. Correct the policy/configuration or isolate the compromised workload.
2. Review budgets, circuit thresholds, and the root cause. Do not clear audit, ledger, or dead-letter state to make a control appear healthy.
3. Require a separately authenticated operator with `safety.reenable`; the stop permission alone is insufficient.
4. Call `reenable({ identity, scope, reason })` and confirm the audit record and persisted switch state.
5. Re-admit only a reviewed action. Approved artifacts still require current policy, identity, idempotency, budget, circuit, kill-switch, and final-commit checks.

## Game Day

The `GhostAPI Kill Switch Game Day` workflow runs at `03:17 UTC` each Monday and can be started manually. It executes only the local synthetic controller test. Investigate a failed drill before trusting the control: a successful alert without a verified blocked action is not sufficient.
