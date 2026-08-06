# Security Policy

GhostAPI exists to make local integration development safer. Security-sensitive behavior should be treated as core product behavior, not an afterthought.

## Supported Versions

GhostAPI is pre-1.0. Security fixes target the current `main` branch and the latest published package once releases begin.

## Safety Model

- GhostAPI does not make real external provider API calls by default.
- External LLM generation requires explicit `--allow-external-llm` or `GHOSTAPI_ALLOW_EXTERNAL_LLM=true` plus `GHOSTAPI_LLM_API_KEY`. Ambient `OPENAI_API_KEY` is ignored by the GhostAPI runtime.
- Incoming requests are normalized and sanitized before use in prompts, cache keys, logs, or dashboard events.
- Secret-looking fields are masked, including `authorization`, `api_key`, `apikey`, `x-api-key`, `access_token`, `refresh_token`, `client_secret`, `password`, `secret`, `token`, and `key`.
- Known token patterns are masked, including Stripe keys, GitHub tokens, Slack bot tokens, SendGrid keys, and bearer tokens.
- State, behaviors, scenarios, and events are sanitized again at persistence boundaries. Cache keys are derived from sanitized requests; cached generated responses preserve provider response fidelity.
- Runtime data defaults to `.ghostapi/` and can be isolated with `GHOSTAPI_DATA_DIR`.
- JSON stores use adjacent inter-process lock files and same-directory temporary-file replacement to avoid covered local lost-update and partial-write scenarios.
- The persisted event log rotates at 5 MiB, retaining two archives. Individual persisted event details are limited to 256 KiB.
- Non-loopback binds fail closed unless `GHOSTAPI_AUTH_TOKEN` contains at least 24 characters. The token protects `/dashboard`, dashboard assets, `/api/*`, and `/events`.
- Loopback remains token-free for local convenience, but hostile browser origins are rejected for dashboard routes.
- `ghostapi doctor` warns when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set.

## Threat Assumptions

- GhostAPI is a local development tool, not a network-isolation boundary. Provider simulation routes remain reachable on the configured bind address, except that remote proxy requests require the dashboard token while external LLM generation is enabled.
- Dashboard authentication provides access control, not transport confidentiality. Use HTTPS or a secure tunnel for any non-loopback bind; never send the token over untrusted plain HTTP.
- Filesystem locks coordinate cooperating GhostAPI processes on one local filesystem. They are not distributed locks and are not guaranteed on network shares or independently synchronized copies.
- On POSIX systems GhostAPI requests owner-only directory/file modes. On Windows, effective access is inherited from the configured directory ACL.
- Secret masking is heuristic. Do not place production credentials or sensitive personal data in scenarios, behaviors, manually edited state, or other local fixtures.
- A process that can read the GhostAPI data directory or inspect the running process environment is inside the trust boundary.
- Query-token bootstrap is accepted only for `GET /dashboard`, then redirected to a URL without the token and stored in an HttpOnly `SameSite=Strict` cookie. API and SSE query tokens are rejected.
- GhostAPI does not claim DNS, process, container, or host-level egress isolation.

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

- Issues requiring malicious local filesystem access already authorized to the GhostAPI data directory.
- Vulnerabilities in unsupported Node.js versions.
- Reports without reproduction details.
