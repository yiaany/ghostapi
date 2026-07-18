# Release Checklist

Use this checklist before publishing GhostAPI to GitHub or npm.

## Metadata

- `package.json` has the correct `name`, `version`, `description`, `license`, `bin`, `files`, `keywords`, and repository metadata.
- `README.md` explains value, install, CLI, provider coverage, examples, safety, and contributing.
- `CHANGELOG.md` has an entry for the release.
- `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md` are present.

## Local Verification

```bash
npm run typecheck
npm test
npm run build
```

Smoke check the built CLI:

```bash
node dist/cli/index.js --help
node dist/cli/index.js providers list
node dist/cli/index.js model get
```

Run local proxy smoke tests:

```bash
node dist/cli/index.js start --offline --port 8080
```

Then verify locally:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/dashboard
curl -X POST http://localhost:8080/v1/customers -H "content-type: application/json" -d '{"email":"ada@example.com"}'
curl http://localhost:8080/v1/customers
curl -X POST http://localhost:8080/emails -H "content-type: application/json" -d '{"from":"dev@example.com","to":"ada@example.com","subject":"Hello"}'
curl -X POST http://localhost:8080/2010-04-01/Accounts/AC123/Messages.json -H "content-type: application/x-www-form-urlencoded" -d "To=+15551234567&From=+15557654321&Body=Hello"
```

## Package Verification

```bash
npm pack --dry-run
```

Confirm the package includes only intended release files and does not include:

- `.ghostapi/`
- `.env`
- `node_modules/`
- local logs
- test output

## Safety Checks

- GhostAPI does not make real provider API calls by default.
- LLM usage requires explicit API key configuration and receives sanitized requests.
- Dashboard events are sanitized.
- Cache keys do not include raw secrets.
- CLI user errors are actionable and do not print confusing stack traces.

## Publish

- Tag the release.
- Push to GitHub.
- Publish to npm only after package dry-run output has been reviewed.
