# Onboarding Smoke Measurement

- Date: 2026-08-09
- Host: Windows, Node.js measured from the local runtime
- Package under test: source build plus tarball smoke for `@yiaany/ghostapi@0.1.7`
- Live provider credentials: not used

## Measured First Useful Result

Measured command sequence:

```bash
npx @yiaany/ghostapi init
npx @yiaany/ghostapi doctor
npx @yiaany/ghostapi start --port <ephemeral>
curl-like POST /v1/customers with authorization: Bearer stripe_test_ghostapi
node examples/openai-streaming/streaming-tool-call.mjs
```

Result on this host: `3.03` seconds from initialization start to successful local Stripe-shaped request plus OpenAI-shaped streaming completion.

This is a Windows local-provider-simulation measurement, not a Linux egress-enforcement measurement. `ghostapi run -- npm test` remains unsupported on Windows and macOS.

## Linux Enforcement Verification

- Date: 2026-08-09
- Host: Ubuntu WSL 2, Node.js `20.20.2`, working copy on the Linux filesystem rather than `/mnt/c`.
- Command: `ghostapi run -- npm test`.
- Result: `48.75` seconds; 42 test files passed, 232 tests passed, and 1 optional test skipped.
- Evidence: the exact run produced a PASS evidence report with a completed `linux-network-namespace` boundary, zero allowed or production egress attempts, no secret categories, and no warnings.

This is an enforced full-suite verification, not a time-to-first-value benchmark: it intentionally runs the entire test suite. The pinned GitHub workflow must still run on the exact release commit before publication.

## Automated Coverage

- `npm run smoke:package` builds a real npm tarball, installs it into a temporary project whose path contains spaces, runs `init`, `doctor --json`, and `providers inspect stripe`, and rejects prompt-pack/session/hosted artifacts plus live-secret-shaped package contents.
- Targeted tests cover CLI parsing, generated setup instructions, and machine-readable doctor output.
