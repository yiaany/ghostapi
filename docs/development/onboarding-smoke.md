# Onboarding Smoke Measurement

- Date: 2026-08-08
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

This is a Windows local-provider-simulation measurement, not a Linux egress-enforcement measurement. `ghostapi run -- npm test` is still unsupported on Windows and macOS; it must be measured separately on a Linux host where namespace preflight passes.

## Automated Coverage

- `npm run smoke:package` builds a real npm tarball, installs it into a temporary project whose path contains spaces, runs `init`, `doctor --json`, and `providers inspect stripe`, and rejects prompt-pack/session/hosted artifacts plus live-secret-shaped package contents.
- Targeted tests cover CLI parsing, generated setup instructions, and machine-readable doctor output.
