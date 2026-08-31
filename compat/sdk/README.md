# Official SDK Compatibility Fixture

This fixture locks and exercises the official Stripe and OpenAI Node SDKs against a built GhostAPI server.

The server binds to a random port on `127.0.0.1`. During SDK execution, a process-level socket guard rejects every connection that does not target that exact loopback address and port. The fixture contains only fake API keys and cannot fall back to either live provider endpoint.

Run from the repository root with:

```bash
npm run test:sdk-compat
```

Compatibility is limited to the versions in this directory's `package-lock.json` and to the exercised customer-create and chat-completion calls. It is not a general live-provider parity claim.
