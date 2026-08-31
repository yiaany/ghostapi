# Generic CI Guide

GhostAPI CI is a four-stage contract: run the project through enforcement, generate a sanitized artifact from that exact run, upload the artifact regardless of policy outcome, and fail the job from the final policy result.

This currently requires a Linux executor that permits GhostAPI's user, mount, network, and PID namespace preflight. Unsupported hosts fail closed. Do not treat SDK base-URL configuration, an HTTP proxy, or a failed preflight as equivalent enforcement.

## Minimal Script

Set `GHOSTAPI_DATA_DIR` to an ephemeral CI directory and use one immutable GhostAPI package version per CI configuration:

```bash
set -u

export GHOSTAPI_DATA_DIR="$CI_WORKSPACE/.ghostapi-ci"
export GHOSTAPI_VERSION="0.1.8"
npm install --global "@yiaany/ghostapi@$GHOSTAPI_VERSION"

run_status=0
ghostapi run --policy ghostapi.policy.yaml -- npm test || run_status=$?

run_path="$(find "$GHOSTAPI_DATA_DIR/runs" -mindepth 2 -maxdepth 2 -name run.json -type f -print | head -n 1)"
evidence_status=0
if [ -n "$run_path" ]; then
  ghostapi evidence generate --policy ghostapi.policy.yaml --run "$run_path" --out "$CI_WORKSPACE/ghostapi-evidence.json" --ci || evidence_status=$?
else
  ghostapi evidence generate --policy ghostapi.policy.yaml --out "$CI_WORKSPACE/ghostapi-evidence.json" --ci || evidence_status=$?
fi

# Always upload ghostapi-evidence.json if it exists. It is the evidence record, not CI logs.
test "$run_status" -eq 0
test "$evidence_status" -eq 0
```

Replace `npm test` with the integration command for the project. Keep the policy file in source control and run the same command locally before opening a pull request:

```bash
GHOSTAPI_DATA_DIR="$(mktemp -d)" ghostapi run --policy ghostapi.policy.yaml -- npm test
```

The report writes a canonical JSON artifact with a logical hash. Use `ghostapi evidence view ghostapi-evidence.json` for a concise terminal summary and `ghostapi evidence compare` when comparing known-good reports. Do not upload raw request logs or runtime directories: they are not the CI evidence contract and may contain more information than the sanitized report.

## CI Safety Requirements

- Pin the GhostAPI package to an exact reviewed version and pin third-party CI plugins to immutable identifiers when the platform supports them.
- Give the test job the smallest read-only repository permission possible.
- Keep provider credentials out of the job; the safe fixture and local runtime use fake values only.
- Upload the sanitized evidence in an always-run collection step, then decide the final job result after upload.
- Treat a comment, chat notification, or dashboard summary as a pointer only. The check result and retained artifact are review evidence, not an immutable audit record.
- Run any write-capable notification or API mutation in a separate job that does not execute untrusted contribution code.
