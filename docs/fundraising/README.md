# GhostAPI Launch And Fundraising Package

**Status as of 2026-08-09:** This package describes a working local release candidate and a proposed customer-validation plan. It does not claim users, revenue, growth, customer quotes, customer outcomes, or a deployed hosted service. The evidence boundary is documented in [metrics-and-evidence.md](metrics-and-evidence.md).

## Category Claim

> Safety and verification infrastructure for software built by AI agents.

GhostAPI starts with a narrow, testable wedge: a local provider simulation runtime plus a Linux-only fail-closed egress boundary and sanitized CI evidence for AI-assisted integration code.

## One-Line Description

GhostAPI helps teams test AI-authored integrations against safe local provider simulations and produce CI evidence that a supported run did not reach production.

## 50-Word Description

GhostAPI is safety and verification infrastructure for software built by AI agents. It simulates selected third-party APIs locally, injects controlled failures, masks secret-shaped data, and on supported Linux hosts runs tests inside a loopback-only network namespace. It produces sanitized CI evidence so reviewers can assess integration behavior before merge.

## Problem And Solution

AI coding agents can write and execute code that creates payments, sends messages, modifies repositories, or calls costly model APIs. A base-URL convention or hand-written mock does not stop a new HTTP client, direct IP call, or subprocess. Teams also need to test ambiguity: `429`, timeouts, duplicate delivery, retries, and idempotency.

GhostAPI gives the integration code a local, provider-shaped test target. On compatible Linux hosts, `ghostapi run` starts the target in a fresh user, mount, network, and PID namespace with loopback only, or refuses to start. CI can then retain a bounded, redacted evidence artifact from the exact run. This is not a guarantee against a hostile host, same-user accessible UNIX control sockets, or every provider behavior.

## Why Now

Coding agents are increasingly able to edit and run integration code in tight loops. That makes external side effects and flaky third-party dependencies part of the code-review surface, rather than a manual testing concern. Existing tools address pieces of the workflow: provider test environments, HTTP mocks, request interception, or CI artifacts. GhostAPI tests whether a combined safety boundary plus deterministic failure evidence is a valuable merge gate.

This is a product hypothesis, not evidence of market demand. The repository has no validated customer interview, weekly CI user, paid pilot, or revenue record as of 2026-08-09.

## Market Framing

GhostAPI is not positioned as "more mocks." It sits between:

- Local API simulation and contract testing for integration development.
- Agent evaluation and reliability testing for generated code.
- CI policy evidence for teams that need to review external side-effect risk.

The initial buyer hypothesis is a Platform Engineering, AppSec, Developer Productivity, or AI governance leader at a 10-200 engineer SaaS team with sensitive payments, communications, source-control, or model-provider integrations.

## Competitive Matrix

This table compares published scopes reviewed on 2026-08-09. It is not a benchmark or a claim that competitors cannot build similar functions.

| Category / primary source | Publicly documented focus | GhostAPI's narrow difference | Boundary |
| --- | --- | --- | --- |
| Stripe test mode and test clocks | Stripe provides test-mode APIs and test clocks for Stripe behavior. | GhostAPI runs a local Stripe-shaped pack and can combine it with local fault behavior and CI evidence. | GhostAPI does not claim live Stripe parity. |
| WireMock | HTTP API mocking, stubbing, and simulation. | GhostAPI adds reviewed provider-shaped packs, MCP controls, and a Linux egress-run/evidence workflow. | WireMock is mature and configurable; GhostAPI must prove why this workflow matters. |
| Mock Service Worker | Network-level request interception with handlers for tests and development. | GhostAPI is a standalone local provider runtime, not browser/app-process interception, and targets agent-controlled integration flows. | MSW remains a strong application-test choice. |
| Postman | API development, testing, and collaboration around collections/APIs. | GhostAPI focuses on executing application/agent code safely in a local runtime and retaining run evidence. | It is not an API-client replacement. |
| GitHub Actions artifacts and checks | CI status checks and artifact retention. | GhostAPI supplies an integration-specific, sanitized evidence artifact and policy result. | GitHub remains the CI platform; GhostAPI is a check within it. |

Primary sources: [Stripe test mode](https://docs.stripe.com/test-mode), [Stripe test clocks](https://docs.stripe.com/billing/testing/test-clocks), [WireMock documentation](https://wiremock.org/docs/), [MSW documentation](https://mswjs.io/docs/), [Postman documentation](https://learning.postman.com/docs/), and [GitHub Actions artifacts](https://docs.github.com/actions/using-workflows/storing-workflow-data-as-artifacts). Recheck these links before external publication.

## Moat Thesis

The potential moat is an evidence chain, not a single simulator: one typed workflow should eventually connect local simulation, sanitized record/replay, deterministic evals, CI policy checks, and bounded production-action controls. Provider compatibility fixtures, incident-derived regression scenarios, and deployment into merge gates could compound over time.

This is a thesis, not a current moat. Today, GhostAPI has a local runtime, an early Stripe pack, policy/evidence/eval primitives, and an undeployed hosted-pilot skeleton. It has no demonstrated switching costs, network effects, customer data advantage, or production action gateway.

## Go-To-Market

1. Recruit five tightly qualified paid-pilot candidates, not a broad self-serve funnel.
2. Lead with one risk: AI-authored Stripe or webhook code running in CI without production credentials or egress proof.
3. Run a 30-minute discovery call, then offer a fixed-scope, 3-4 week validation pilot only if a buyer owns the risk.
4. Require one Linux CI workflow, one deterministic failure path, a named technical owner, and a closeout decision.
5. Publish useful OSS examples and a technical launch only after the exact release commit passes the pinned Linux CI workflow.
6. Use observed adoption, blocked workflows, and buyer decisions to decide whether shared CI evidence is worth hosted product work.

## Pricing Summary

- **OSS Local:** available, MIT licensed, local-first, and free. It has no account, paywall, or hosted dependency.
- **Team:** a proposed fixed-scope design-partner pilot, not a generally available plan. No public price is validated.
- **Enterprise:** discovery only. No hosted deployment, SSO/SCIM, SLA, billing, or production-action service is available for purchase.

See [commercial/pricing.md](../commercial/pricing.md) for the evidence-led pricing experiment and [commercial/manual-invoicing.md](../commercial/manual-invoicing.md) for the manual-pilot boundary.

## Package Index

- [Metrics and evidence boundary](metrics-and-evidence.md)
- [Three-minute technical demo](demo-script.md)
- [Launch posts](launch-posts.md)
- [YC-style application answers](yc-application.md)
- [50 design-partner targets](design-partners-50.md)
- [Data room checklist](data-room-checklist.md)
- [12-month gated roadmap](roadmap-12-month.md)
- [Technical due diligence index](technical-due-diligence-index.md)
