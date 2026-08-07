# GhostAPI CI Smoke Fixture

This fixture is used by the repository's GitHub Actions reference workflow and can be run on a Linux host that supports GhostAPI namespaces.

```bash
export GHOSTAPI_DATA_DIR="$(mktemp -d)"
ghostapi run --policy ghostapi.policy.yaml -- npm run test:safe
```

The safe command sends a request only to the GhostAPI endpoint injected by `ghostapi run`. It records `ci.safe_ghostapi`, which the fixture policy requires.

The unsafe command is a regression test for the namespace boundary. It must exit non-zero when run through GhostAPI:

```bash
if ghostapi run --policy ghostapi.policy.yaml -- npm run test:production-egress; then
  echo "unexpected production egress"
  exit 1
fi
```

The unsafe fixture must never be run directly on a developer machine or ordinary CI executor because it intentionally targets `api.stripe.com`.
