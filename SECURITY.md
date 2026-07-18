# Security Policy

GhostAPI exists to make local integration development safer. Security-sensitive behavior should be treated as core product behavior, not an afterthought.

## Supported Versions

GhostAPI is pre-1.0. Security fixes target the current `main` branch and the latest published package once releases begin.

## Safety Model

- GhostAPI does not make real external provider API calls by default.
- Incoming requests are normalized and sanitized before use in prompts, cache keys, logs, or dashboard events.
- Secret-looking fields are masked, including `authorization`, `api_key`, `apikey`, `x-api-key`, `access_token`, `refresh_token`, `client_secret`, `password`, `secret`, `token`, and `key`.
- Known token patterns are masked, including Stripe keys, GitHub tokens, Slack bot tokens, SendGrid keys, and bearer tokens.
- Local cache entries are stored under `.ghostapi/cache/{provider}/{hash}.json`.
- Local state is stored under `.ghostapi/state.json`.
- `ghostapi doctor` warns when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set.

## Reporting A Vulnerability

Please do not open a public issue for a vulnerability.

Until a dedicated security email is published, report privately to the project maintainer or repository owner and include:

- A clear description of the issue.
- Steps to reproduce.
- Expected impact.
- Whether secrets, prompts, cache, state, dashboard events, or network behavior are involved.
- Suggested fix, if you have one.

We will acknowledge valid reports as quickly as possible and prioritize fixes that could leak secrets, trigger real external calls unexpectedly, or expose local data.

## Out Of Scope

- Issues requiring malicious local filesystem access outside GhostAPI's process permissions.
- Vulnerabilities in unsupported Node.js versions.
- Reports without reproduction details.
