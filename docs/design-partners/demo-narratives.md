# Demo Narratives

These are scripted demonstrations, not customer outcomes. Label them as demos until a user provides a dated, sanitized real-world record.

## 1. Prevented Production Egress

**Buyer pain:** A coding agent can use a different HTTP client or shell command than the application's configured SDK and bypass a base-URL convention.

**Story:** A developer runs an AI-generated integration test with `ghostapi run` on a supported Linux runner. The test tries to contact a non-loopback provider host. The namespace boundary denies external network routing while GhostAPI records only the permitted local interaction. The CI job publishes a sanitized evidence artifact and blocks merge because the requested external path cannot be safely proven.

**Proof to show:** Linux preflight receipt, policy, sanitized evidence artifact, and failed CI status. Do not claim attribution of denied kernel socket attempts beyond the backend's documented capability.

**Ask:** "Would an artifact showing the enforced boundary and the required scenario change how your team reviews agent-authored integration code?"

## 2. Duplicate Payment Bug Caught

**Buyer pain:** A timeout after an ambiguous payment response can cause unsafe retry behavior and duplicate charges.

**Story:** The demo uses GhostAPI's deterministic Stripe-shaped duplicate-payment eval. A deliberately unsafe sample retries a payment mutation without preserving idempotency. The evidence ties the repeated request sequence to the scenario; the eval fails before merge. The corrected implementation reuses the idempotency key and passes the ordered retry proof.

**Proof to show:** The exact local scenario, evidence hash, failed eval, corrected eval, and no production credential.

**Ask:** "Which of your real workflows has this kind of ambiguous-result or duplicate-side-effect risk?"

## 3. PR Blocked For Missing Webhook Signature Validation

**Buyer pain:** A webhook handler may work in a happy-path test yet accept unsigned or incorrectly signed payloads.

**Story:** A pull request adds a webhook endpoint but does not prove signature verification. The policy requires the webhook-signature eval. The CI report marks the requirement missing and returns a failing status. After the developer adds verification and the negative signed/invalid-signature test, the same required check passes.

**Proof to show:** Required policy scenario, failing PR check, sanitized evidence showing the missing expectation, and passing artifact after the negative test.

**Ask:** "Which security or integration checks do reviewers currently have to remember manually?"
