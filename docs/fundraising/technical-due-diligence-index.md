# Technical Due Diligence Index

## Product Runtime

- [Root README](../../README.md): quickstart, local capabilities, platform support, and safety limits.
- [Usage guide](../usage.md): commands, policy, evidence, eval, record/replay, contracts, and telemetry.
- [Provider authoring](../providers/authoring-packs.md): provider-pack boundary and conformance model.
- [Stripe pack](../providers/stripe-core-pack.md): implemented Stripe-shaped capabilities and limits.

## Security

- [Security policy](../../SECURITY.md)
- [Egress threat model](../security/egress-threat-model.md)
- [Policy as code](../policy.md)
- [Release readiness](../release-readiness.md)
- [Release migration and rollback](../release-migration-and-rollback.md)
- [Release checklist](../release-checklist.md)

## CI And Evidence

- [GitHub Actions PR safety check](../github-actions.md)
- [Generic CI guide](../ci.md)
- [Reference workflow](../../.github/workflows/ghostapi-pr-safety.yml)
- [CI smoke fixture](../../examples/ci-smoke/README.md)
- [Agent eval example](../../examples/evals/README.md)

## Architecture And Operations

- [Team-control-plane prototype](../team-control-plane.md): local-only model and security boundaries.
- [Hosted pilot](../hosted-pilot.md): undeployed architecture and deployment gates.
- [Design-partner validation kit](../design-partners/README.md)
- [Commercial readiness](../commercial/README.md)
- [Session log](../../../SESSION_LOG.md): chronological implementation and verification history; verify against source and Git history.

## Verification Snapshot

Session 22 on 2026-08-09 passed the Windows root suite (225 passed, 8 Linux-only skips), typecheck, build, packed-package smoke, and production dependency audit. It also passed the Linux root suite in Ubuntu WSL 2 on Node.js 20.20.2 (232 passed, 1 optional skip), including the namespace egress suite and an actual safe-evidence/blocked-egress CI smoke run. The pinned GitHub Linux CI workflow still must run on the exact external release commit before publication. Full development dependency audit remains open for five Vite/Vitest/esbuild findings. See [metrics-and-evidence.md](metrics-and-evidence.md) and [release-readiness.md](../release-readiness.md).
