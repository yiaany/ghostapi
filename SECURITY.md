# Security Policy

GhostAPI is a local API simulation tool with an optional Linux process-egress boundary. Security claims are limited to documented, tested behavior.

## Supported Versions

GhostAPI is pre-1.0. Security fixes target the current `main` branch and the latest published npm version. Older `0.1.x` versions may not receive fixes.

## Safety Model

- GhostAPI does not make real external provider API calls by default.
- External LLM generation requires explicit `--allow-external-llm` or `GHOSTAPI_ALLOW_EXTERNAL_LLM=true` plus `GHOSTAPI_LLM_API_KEY`. Ambient `OPENAI_API_KEY` is ignored by the GhostAPI runtime.
- Incoming requests sent to GhostAPI are normalized and heuristically sanitized before use in prompts, cache keys, logs, or dashboard events.
- Secret-looking fields are masked, including `authorization`, `api_key`, `apikey`, `x-api-key`, `access_token`, `refresh_token`, `client_secret`, `password`, `secret`, `token`, and `key`.
- Known token patterns are masked, including Stripe keys, GitHub tokens, Slack bot tokens, SendGrid keys, and bearer tokens.
- State, behaviors, scenarios, and events are sanitized again at persistence boundaries. Cache keys are derived from sanitized requests; cached generated responses preserve provider response fidelity.
- Runtime data defaults to `.ghostapi/` and can be isolated with `GHOSTAPI_DATA_DIR`.
- JSON stores use adjacent inter-process lock files and same-directory temporary-file replacement to avoid covered local lost-update and partial-write scenarios.
- The persisted event log rotates at 5 MiB, retaining two archives. Individual persisted event details are limited to 256 KiB.
- Non-loopback binds fail closed unless `GHOSTAPI_AUTH_TOKEN` contains at least 24 characters. Every route except `/` and `/health` requires the token on a non-loopback bind, including provider simulation routes, dashboard/control routes, SSE, and `/health/readiness`.
- Loopback remains token-free for local convenience, but hostile browser origins are rejected for dashboard routes.
- `ghostapi doctor` warns when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set.

## Threat Assumptions

- `ghostapi start` is a local simulation endpoint, not process-egress enforcement. Clients and subprocesses can still call other network destinations unless separately contained.
- On supported Linux hosts, `ghostapi run` can enforce a loopback-only network namespace after successful preflight. It does not provide a hostile-code filesystem sandbox, hide same-user UNIX sockets, or enumerate kernel-denied socket attempts in evidence.
- Dashboard authentication provides access control, not transport confidentiality. Use HTTPS or a secure tunnel for any non-loopback bind; never send the token over untrusted plain HTTP.
- Filesystem locks coordinate cooperating GhostAPI processes on one local filesystem. They are not distributed locks and are not guaranteed on network shares or independently synchronized copies.
- On POSIX systems GhostAPI requests owner-only directory/file modes. On Windows, effective access is inherited from the configured directory ACL.
- Secret masking is heuristic. Do not place production credentials or sensitive personal data in scenarios, behaviors, manually edited state, or other local fixtures.
- A process that can read the GhostAPI data directory or inspect the running process environment is inside the trust boundary.
- MCP clients are inside the trust boundary. MCP tools can read retained traffic and state and modify local simulation behavior; MCP is not an authentication or egress boundary.
- Evidence logical hashes detect accidental content changes while the runtime and local storage remain trusted. They are not signatures, immutable provenance, or protection from an actor who can modify the report and recompute its hash.
- Query-token bootstrap is accepted only for `GET /dashboard`, then redirected to a URL without the token and stored in an HttpOnly `SameSite=Strict` cookie. API and SSE query tokens are rejected.
- GhostAPI does not claim complete secret redaction, live-provider parity, Windows/macOS process-egress enforcement, container isolation, host isolation, compliance certification, or production credential execution.

## Reporting A Vulnerability

Please do not open a public issue for a vulnerability.

Use GitHub Private Vulnerability Reporting for `yiaany/ghostapi`. If that option is unavailable, contact the repository owner privately rather than opening a public issue. Include:

- A clear description of the issue.
- Steps to reproduce.
- Expected impact.
- Whether secrets, prompts, cache, state, dashboard events, or network behavior are involved.
- Suggested fix, if you have one.

Reports are handled on a best-effort basis; there is no response-time SLA. Priority is given to issues that could expose retained data, cross a documented authorization boundary, or cause unexpected external calls.

## Out Of Scope

- Same-user modification that does not cross a documented trust boundary. Issues that enable unexpected external calls, privilege crossing, or disclosure beyond that boundary remain in scope.
- Vulnerabilities in unsupported Node.js versions.
- Reports without reproduction details.
