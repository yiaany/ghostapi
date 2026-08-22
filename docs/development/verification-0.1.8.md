# 0.1.8 Verification Record

- Date: 2026-08-22
- Package: `@yiaany/ghostapi@0.1.8`
- Scope: final local release verification, package/release evidence, hosted checks, Docker build, and native Linux enforcement
- Historical records: the 2026-08-05 baseline and 2026-08-09 onboarding smoke remain records of `0.1.7` and were not re-dated or relabeled

## Verification

This record is intentionally separate from the historical baseline and onboarding measurements. All results below passed against the final 0.1.8 working tree on 2026-08-22. GitHub Actions still must be observed on the exact final commit after that commit is pushed; local and WSL2 results do not substitute for that post-push check.

| Check | Result | Evidence |
| --- | --- | --- |
| Root lint | PASS | `npm run lint`; configured Prettier check passed |
| Root typecheck | PASS | `npm run typecheck`; completed without diagnostics |
| Root tests | PASS | `npm test`; 55 files and 341 tests passed with zero skipped |
| Root build | PASS | `npm run build`; TypeScript and static dashboard builds completed |
| Package smoke | PASS | `npm run smoke:package`; packed artifact installed and its CLI, package export, generated project, doctor, and provider checks passed |
| Root dependency audits | PASS | Full `npm audit` and production-only `npm audit --omit=dev` both reported zero vulnerabilities |
| Hosted clean install and check | PASS | Fresh `npm ci`, then `npm run check`; hosted typecheck, 26 tests with zero skipped, and Bun build passed |
| Hosted dependency audit | PASS | `npm audit --audit-level=low`; zero vulnerabilities |
| Hosted Docker image | PASS | Local Docker image build completed, including frozen install, hosted typecheck, tests, Bun build, production dependency pruning, and non-root runtime image assembly |
| Hosted PostgreSQL migrations and quota race | PASS | Forward migrations `001` through `004` applied to PostgreSQL 17; two concurrent organization creates against a quota of one produced one success, one rejection, and one persisted organization |
| Native Ubuntu WSL2 Linux enforcement | PASS | Native Ubuntu WSL2 enforcement suite passed 12 of 12 tests with zero skipped, exercising the Linux namespace boundary rather than the Windows fallback path |
| GitHub Actions on exact final commit | PENDING POST-PUSH | Observe the pinned workflows on the exact final commit after push and retain the run/evidence links before publication; do not infer this result from the local verification |
