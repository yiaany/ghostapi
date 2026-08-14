# Launch Posts

Use only after the exact release commit has passed the pinned Linux CI workflow. Replace bracketed fields with verified facts or remove them. Do not add customer, revenue, install, or performance claims without a dated source.

## Hacker News: Show HN

**Title:** Show HN: GhostAPI - local API simulation and CI evidence for AI-authored integrations

**Post:**

I built GhostAPI because AI coding agents can write and run integration code, but a base URL and a mock alone do not show reviewers whether a test touched production or exercised failure paths.

GhostAPI runs provider-shaped APIs locally, exposes deterministic controls through MCP, masks secret-shaped values, and on compatible Linux hosts can run a target in a loopback-only namespace. It can produce a sanitized evidence artifact for CI.

The first deep provider pack is Stripe-shaped local simulation. The repo includes examples for `429`, delayed responses, duplicate webhook delivery, policy checks, record/replay, and a GitHub Actions reference workflow.

Important limits: Linux enforcement requires `unshare` and `iproute2` preflight; Windows/macOS do not have equivalent process enforcement. This is not a hostile-code filesystem sandbox or a hosted service.

I am looking for teams that use coding agents on Stripe/webhook/integration code and can test one CI workflow. What failure path or review decision would make an artifact like this useful?

## Reddit

**Title:** I made a local safety/evidence layer for AI-authored API integrations. Looking for harsh feedback.

AI coding agents make it easier to create integration code, but they also make it easier to run tests that call real providers or skip retry/idempotency edge cases. GhostAPI is an OSS local runtime that simulates selected APIs, lets an agent configure deterministic failures through MCP, and creates a sanitized CI artifact.

On supported Linux hosts, `ghostapi run` uses a loopback-only namespace and fails closed if it cannot create it. On Windows/macOS it is local simulation only, not egress enforcement.

I am not claiming traction or a hosted enterprise product. I want feedback from engineers who have had to review AI-authored Stripe, webhook, email, or model-provider code: would a reproducible `429`/timeout/duplicate-delivery test plus CI evidence change your merge process? What would make it unusable?

## X / LinkedIn

AI coding agents can write integration code. The harder question is how a team proves that agent-authored tests stayed off production and exercised the failure paths that cause duplicate payments, bad retries, or unsafe webhooks.

GhostAPI is an OSS local runtime for that narrow problem: provider-shaped simulation, MCP-controlled deterministic failures, secret masking, and Linux-only fail-closed egress runs with sanitized CI evidence.

No hosted service or customer traction claims yet. I am recruiting teams willing to validate one real CI workflow around Stripe, webhooks, or other high-risk integrations.
