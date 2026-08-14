# Three-Minute Technical Demo

## Claim And Limits

Show a reproducible technical demonstration, not a customer result:

> An AI coding agent can write unsafe Stripe integration code; GhostAPI can keep a supported Linux test run off production, make failure paths deterministic, and publish sanitized evidence for review.

Run the enforcement portion only on a compatible Linux runner. Windows and macOS can demonstrate local simulation and MCP behavior controls, but cannot demonstrate `ghostapi run` egress enforcement. Do not run the direct-production-egress fixture outside the enforced Linux boundary.

The current eval runner deliberately does **not** auto-apply declared `injectedFailures`; configure the failures through MCP before the run. This is an operator-orchestrated demo, not one fully automatic command.

## Preflight

1. Use a clean checkout of the proposed release commit on Linux with Node.js 20+, `unshare`, and `iproute2`.
2. Run `npm ci`, `npm run build`, and `node dist/cli/index.js doctor --egress --json`.
3. Use a temporary `GHOSTAPI_DATA_DIR`; use only fake Stripe keys.
4. Prepare a small agent-authored test with three cases: retry a `429` while honoring `Retry-After`, abort a delayed local response, and de-duplicate a pull-delivered Stripe webhook. The existing [Stripe example](../../examples/stripe-node/README.md) demonstrates local duplicate webhook delivery.
5. Start the GhostAPI MCP server using the checked-out build. Ask the coding agent to configure these deterministic local controls before it writes/runs tests:

```text
set_api_behavior POST /v1/payment_intents
  status: 429
  headers: { retry-after: "1" }

set_api_behavior POST /v1/customers
  status: 200
  delayMs: 1500
```

`delayMs` is bounded to 10 seconds and only delays the specified local behavior. It does not affect a live provider.

## Live Script

| Time | What to show | What to say |
| --- | --- | --- |
| 0:00-0:25 | Give the agent the task: create a Stripe Payment Intent helper with retry/idempotency and webhook de-duplication. | "The point is not that the agent can call Stripe. The point is that the test environment makes dangerous and ambiguous behavior visible before merge." |
| 0:25-0:50 | Show the first agent implementation: it retries after `429` but reuses neither an idempotency key nor timeout-safe state; its webhook handler processes the duplicate twice. | "This is deliberately unsafe demo code, not a production incident." |
| 0:50-1:20 | Run its test through `ghostapi run --policy ghostapi.policy.yaml -- npm test`. The local 429, delayed response, and duplicate delivery reveal the defects. | "The target has loopback only if Linux preflight succeeds. If preflight fails, GhostAPI refuses to launch it." |
| 1:20-1:40 | Run the reference blocked-egress regression: `ghostapi run --policy examples/ci-smoke/ghostapi.policy.yaml -- npm --prefix examples/ci-smoke run test:production-egress`. It must exit non-zero. | "This direct `api.stripe.com` attempt is intentionally blocked by the namespace. The current backend does not attribute each kernel-denied socket individually." |
| 1:40-2:05 | Ask the agent to retain one idempotency key across retry, stop on client timeout, and de-duplicate webhook event IDs. Re-run the local tests. | "The fix is application behavior; GhostAPI exposes the failure path without production credentials or outbound provider calls." |
| 2:05-2:35 | Run the fixed tests through `ghostapi run` and generate evidence from the exact run: `ghostapi evidence generate --policy ghostapi.policy.yaml --run <run.json> --out ghostapi-evidence.json --ci`. | "The evidence is bounded and redacted. It is the review record, not raw request logs." |
| 2:35-3:00 | Show the `Enforced safety check` status and uploaded artifact using the reference [PR workflow](../github-actions.md). | "The claim is narrow: this supported run passed its policy with zero recorded production attempts. It is not a general host sandbox, hosted service, or absolute safety guarantee." |

## Expected Outcomes

- The unsafe implementation's unit/integration assertions fail on `429`, timeout, or duplicate webhook handling.
- The direct-production-egress fixture exits non-zero only within a successful Linux namespace run.
- The corrected implementation's local tests pass.
- The fixed CI run produces a sanitized evidence artifact and passes the chosen policy.

Do not claim that GhostAPI automatically discovered the bug, injected eval-declared failures by itself, prevented a real production incident, or proves every route from an agent to the internet is impossible.
