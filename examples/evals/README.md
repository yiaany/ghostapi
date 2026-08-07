# GhostAPI Agent Eval Demo

This directory shows the coding-agent workflow for deterministic evals.

1. Run the agent's integration tests through the safety boundary on a supported Linux host:

```bash
ghostapi run -- npm test
```

2. Generate sanitized evidence for the run:

```bash
ghostapi evidence generate --run .ghostapi/runs/<run-id>/run.json --out .ghostapi/reports/agent.json
```

3. Score the evidence with a built-in template or the local JSON spec:

```bash
ghostapi eval --template retry-after --evidence .ghostapi/reports/agent.json --ci
ghostapi eval --spec examples/evals/retry-after.eval.json --evidence .ghostapi/reports/agent.json --json
```

If `--evidence` is omitted, `ghostapi eval --spec ...` launches `task.command` through `ghostapi run`; it never executes the command outside that boundary. Core score is deterministic and evidence-based. LLM judging is not required and does not affect the security score.
