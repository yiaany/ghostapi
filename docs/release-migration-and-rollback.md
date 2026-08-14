# Release Migration And Rollback

Last reviewed: 2026-08-08.

This guide covers the published local `@yiaany/ghostapi` package. The separate `hosted/` pilot is not part of the npm package and has no production migration or rollback approval.

## Before Upgrade

1. Read the target `CHANGELOG.md`, `SECURITY.md`, platform limitations, and package contents.
2. Keep the project policy and scenarios under normal source control only if they contain no sensitive data. `.ghostapi/` can contain local simulation data and evidence; do not upload it as a generic backup.
3. If a local backup is needed, make an access-controlled copy of only the required `.ghostapi/` files and review it for secrets before transferring it.
4. Run `ghostapi doctor --json`. On Windows and macOS, use `ghostapi start --open` for local simulation; do not expect `ghostapi run` enforcement.

## Upgrade

```bash
npx @yiaany/ghostapi@<version> init
npx @yiaany/ghostapi@<version> doctor --json
```

`init` does not overwrite existing setup files. Review generated setup guidance rather than replacing local policy or agent instructions blindly.

For a source checkout, install the pinned lockfile and run:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:package
```

On supported Linux runners, also run the selected enforced workflow and generate a sanitized evidence report. A successful Windows/macOS local simulation must not be used as substitute evidence for Linux namespace enforcement.

## Rollback

1. Stop the local GhostAPI process or CI job.
2. Reinstall the previously reviewed package version or return the source checkout to the previously reviewed commit using the repository's normal non-destructive deployment procedure.
3. Re-run `ghostapi doctor --json` and the same local smoke or CI workflow used before the upgrade.
4. Preserve only sanitized evidence needed to explain the rollback. Do not attach raw traffic, secrets, source code, or local data directories to an issue.
5. If a local data schema rejects an older runtime, do not hand-edit or delete data in place. Work on an access-controlled copy, report the exact version/error through the security or maintainer channel, and retain the original until a recovery path is reviewed.

## Rollback Scope

- The current local runtime has no account, hosted entitlement, billing state, or remote control plane to roll back.
- `ghostapi telemetry disable` removes the optional local aggregate; it is not a product-version rollback tool.
- Local file locks coordinate cooperating processes on one filesystem only. Do not attempt a rollback while concurrent GhostAPI processes write the same data directory.

## Release Verification

Run these on the proposed release commit:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:package
npm pack --dry-run
npm audit --omit=dev
```

Also review the package file list, tracked-source secret scan, direct runtime dependency licenses, GitHub workflow permissions/action pins, and the known gaps in [release readiness](release-readiness.md). The full `npm audit` result currently has known dev-toolchain findings and is not a publication pass signal.
