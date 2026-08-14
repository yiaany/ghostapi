# ICP One-Pager

## Primary ICP

SaaS companies with 10-200 engineers that actively use AI coding agents and operate sensitive Stripe, OpenAI, GitHub, Twilio, Resend, webhook, or generic external integrations.

## Buyer And User

| Role | Job | Pain To Validate |
| --- | --- | --- |
| Head of Platform / Developer Productivity | Make agent-assisted development safe and repeatable | Cannot prove AI-written integration tests stayed away from production. |
| AppSec / AI governance lead | Reduce credential and external-action exposure | Agent workflows create new egress and secret-leak paths without enforceable evidence. |
| Engineering manager / CTO | Ship integrations without operational surprises | Retry, webhook, and idempotency bugs reach review or production too late. |
| AI engineer / SDET / senior developer | Test the code the agent produced | Mocks are incomplete, manual setup is slow, and failures are hard to reproduce in CI. |

## Trigger

- The team has had an agent, test, script, or integration contact a real provider unexpectedly.
- A payment, webhook, retry, or timeout defect escaped review.
- The team is writing AI-agent governance or CI policy and cannot produce a credible evidence artifact.
- A platform team is standardizing coding-agent workflows across repositories.

## Job To Be Done

When an AI coding agent creates or modifies an external integration, help the team run a deterministic local/CI verification that blocks unsafe egress and proves the relevant failure path was exercised, so reviewers can merge without handing the agent production credentials or trusting an unverifiable mock.

## Current Alternatives

- SDK base-URL overrides, test-mode keys, and manual reviewer discipline.
- Generic mocks, contract tests, or API virtualization.
- CI logs and informal screenshots.
- Restricting agents from integration work entirely.

## Disqualifiers

- No coding-agent use and no external integrations.
- The only need is a hosted dashboard or generic API mocking.
- The buyer expects host-level sandboxing on unsupported Windows/macOS hosts.
- The team cannot run a small local or Linux CI experiment.

## Qualification Signal

Prioritize a pilot only if the team can name one repository, one sensitive integration, one failure mode, and one merge/release workflow where evidence would change a decision.
