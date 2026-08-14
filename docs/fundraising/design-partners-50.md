# 50 Design-Partner Targets

This is an account list for research and outreach, not evidence that any company is interested, uses AI coding agents, has the required provider stack, or has been contacted. Do not infer a personal contact from this list. Before outreach, verify the current engineering size, relevant integration risk, public AI-development posture, and appropriate Platform/AppSec/Developer Productivity/Engineering leader through public company channels.

## Qualification Criteria

- B2B SaaS or developer-facing company with an externally integrated product.
- Plausible risk from payments, communications, source-control, webhooks, cloud APIs, or model-provider APIs.
- Likely ability to run one compatible Linux CI workflow.
- A team that can name a technical owner and a buyer for a 3-4 week fixed-scope pilot.

## Targets

| # | Account | Segment | Why It May Fit | Outreach Thesis |
| ---: | --- | --- | --- | --- |
| 1 | Vercel | Developer platform | Agent-assisted development and deployment integrations. | Can a CI artifact improve review of agent-authored integration code? |
| 2 | Sentry | Developer tooling | Error, alerting, and webhook integrations. | Test retries and external notifications without live side effects. |
| 3 | PostHog | Product analytics | Event, webhook, and developer-platform workflows. | Make integration failures repeatable in CI. |
| 4 | Render | Cloud platform | Customer-facing provisioning and API workflows. | Validate agent-authored API clients against bounded failures. |
| 5 | Railway | Cloud platform | Deployment and API-heavy developer workflows. | Test agent changes without reaching production services. |
| 6 | Fly.io | Cloud platform | Infrastructure APIs and release automation. | Review egress and failure behavior before merge. |
| 7 | Supabase | Backend platform | Auth, database, webhook, and API ecosystems. | Exercise client retries and webhook validation locally. |
| 8 | Clerk | Identity platform | Auth and webhook integration risk. | Verify duplicate deliveries and failure handling in CI. |
| 9 | Auth0 | Identity platform | Security-sensitive identity integrations. | Establish deterministic negative-path evidence. |
| 10 | WorkOS | Enterprise identity | Webhook and directory-sync integrations. | Test high-risk callbacks without live tenant data. |
| 11 | LaunchDarkly | Feature management | SDK and webhook-heavy platform surface. | Gate agent-authored integration tests on evidence. |
| 12 | Datadog | Observability | Alerting and API integrations. | Test rate limits and retries without production calls. |
| 13 | New Relic | Observability | Instrumentation and notification integrations. | Identify whether local evidence changes review workflow. |
| 14 | Honeycomb | Observability | Event and API-driven engineering teams. | Evaluate deterministic failure testing for agents. |
| 15 | Grafana Labs | Observability | Plugins, alerts, and external service integrations. | Test outbound boundaries in contributor/CI flows. |
| 16 | PagerDuty | Incident response | External notification and automation risk. | Reproduce failed notification and retry behavior safely. |
| 17 | Incident.io | Incident response | Slack, webhook, and automation workflows. | Test duplicate event and timeout recovery paths. |
| 18 | Linear | Collaboration software | GitHub and notification integrations. | Evaluate safe integration changes authored by agents. |
| 19 | Notion | Collaboration software | API and webhook ecosystem. | Test agent changes against local provider-shaped boundaries. |
| 20 | Airtable | Workflow platform | Automation and third-party API workflows. | Test deterministic error handling before merge. |
| 21 | Zapier | Automation platform | Multi-provider side-effect risk. | Pick one workflow where egress evidence changes a release decision. |
| 22 | n8n | Workflow automation | User-configured external integrations. | Test agent-generated nodes without provider credentials. |
| 23 | Retool | Internal-tools platform | Customer API connections and agent-assisted builds. | Enforce a safe test target for generated integrations. |
| 24 | Temporal | Workflow orchestration | Retry, timeout, and idempotency-heavy workflows. | Validate integration behavior under controlled ambiguity. |
| 25 | Airbyte | Data integration | Connector and external API reliability risk. | Test connector behavior with bounded local scenarios. |
| 26 | Fivetran | Data integration | Provider APIs, auth, and retry semantics. | Explore a reproducible failure-evidence workflow. |
| 27 | Pipedream | Developer automation | Code steps calling many provider APIs. | Keep agent-authored tests out of production by default. |
| 28 | Algolia | Search platform | SDK and webhook/API customer integrations. | Test provider failures and evidence artifacts in CI. |
| 29 | Amplitude | Product analytics | Event ingestion, API, and integration surface. | Validate one agent-generated client failure path before merge. |
| 30 | Snyk | Developer security | AppSec buyer overlap and CI-native workflows. | Assess whether evidence adds value beyond code scanning. |
| 31 | Semgrep | Developer security | CI policy and AI-code review focus. | Test a complementary runtime-evidence workflow. |
| 32 | Sonar | Code quality | AI-generated-code review focus. | Determine whether integration evidence complements static checks. |
| 33 | GitLab | DevOps platform | CI, security, and integration ecosystem. | Explore a narrow CI evidence pilot, not a platform replacement. |
| 34 | CircleCI | CI platform | CI-native customer base and external integrations. | Test whether a reusable safety check is valuable to users. |
| 35 | Harness | Delivery platform | Policy and controlled automation use cases. | Validate egress evidence around one AI-assisted workflow. |
| 36 | Buildkite | CI platform | Engineering teams with flexible CI environments. | Qualify Linux enforcement and artifact retention needs. |
| 37 | HashiCorp | Infrastructure software | API-driven provisioning and security-sensitive workflows. | Assess a narrowly scoped egress/evidence workflow. |
| 38 | Stripe | Payments platform | Payment lifecycle and developer test workflows. | Explore local deterministic payment-failure evidence. |
| 39 | Paddle | Payments platform | Billing and webhook integrations. | Test duplicate delivery and idempotency paths in CI. |
| 40 | Adyen | Payments platform | High-stakes payment integrations. | Qualify whether local simulation adds value to existing test tools. |
| 41 | Plaid | Financial data APIs | Sensitive API and webhook workflows. | Test safe failure/retry behavior without live access. |
| 42 | Mercury | Fintech | Banking workflow side-effect sensitivity. | Validate whether evidence alters one release decision. |
| 43 | Brex | Fintech | Spend and payment integrations. | Explore bounded agent integration testing with no production credentials. |
| 44 | Rippling | HR platform | Payroll, identity, and integration complexity. | Test webhook and external workflow failure paths. |
| 45 | Gusto | HR/payroll | High-consequence external integrations. | Qualify one non-production CI workflow only. |
| 46 | Webflow | SaaS platform | API, app ecosystem, and automation workflows. | Test agent-authored apps/integrations before merge. |
| 47 | Intercom | Customer communications | Messaging/webhook side-effect risk. | Test retries, rate limits, and no-live-send workflow. |
| 48 | Twilio | Communications platform | Messaging API and webhook ecosystem. | Exercise agent-generated integration failures locally. |
| 49 | Resend | Email platform | Email-send integration and developer experience. | Test no-live-send and retry evidence in CI. |
| 50 | ElevenLabs | AI platform | API usage, spend, and model-provider integration risk. | Test agent code against local provider-shaped responses. |

## Outreach Sequence To Five Paid-Pilot Decisions

1. Research 50 accounts and select 20 that meet all four qualification criteria.
2. Send 20 concise role-based outreach notes asking for a 20-minute discovery call about one existing integration review or failure path; do not claim a customer result.
3. Run 10 discovery calls using [the question set](../design-partners/discovery-questions.md). Record only a dated, sanitized private summary.
4. Invite the 5 strongest fits to a live technical demo and ask each for a binary pilot decision, named owner, one Linux CI workflow, and a 3-4 week time commitment.
5. Offer a written fixed-scope paid-pilot proposal only where the buyer confirms a budget process and measurable success criteria. Count a decision of "no," "later," or "OSS only" as a valid outcome; do not convert interest into traction.
6. Target outcome: five paid-pilot **decisions**, not five fabricated contracts. Success is at least one signed paid pilot or a documented reason to reshape the wedge.
