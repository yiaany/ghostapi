# GitHub Actions PR Safety Check

GhostAPI can make a pull request check fail when its enforced integration run or policy evidence fails. The status check and sanitized JSON artifact are review evidence; a pull request comment is optional convenience output only. These artifacts are not immutable audit records.

The repository workflow at [`.github/workflows/ghostapi-pr-safety.yml`](../.github/workflows/ghostapi-pr-safety.yml) is a working reference. It packs the checked-out GhostAPI source, verifies that its package version exactly matches `GHOSTAPI_VERSION`, then installs that exact version before running the smoke fixture. For a consuming repository, install the published package at an exact version instead:

```yaml
env:
  GHOSTAPI_VERSION: "0.2.0"

- name: Install pinned GhostAPI
  run: npm install --global "@yiaany/ghostapi@$GHOSTAPI_VERSION"
```

Update the version only as part of a reviewed GhostAPI upgrade. Keep third-party Actions pinned to full commit SHAs, not mutable tags.

## Required Job Shape

Run the project command through enforcement, then generate evidence from that exact run:

```yaml
- name: Run integration tests through enforcement
  id: run
  continue-on-error: true
  run: |
    ghostapi run --policy ghostapi.policy.yaml -- npm test
    evidence_path="$(find "$GHOSTAPI_DATA_DIR/runs" -mindepth 2 -maxdepth 2 -name run.json -type f -print | head -n 1)"
    test -n "$evidence_path"
    echo "evidence_path=$evidence_path" >> "$GITHUB_OUTPUT"

- name: Generate evidence
  id: evidence
  if: ${{ always() }}
  continue-on-error: true
  run: |
    if [ -n "${{ steps.run.outputs.evidence_path }}" ]; then
      ghostapi evidence generate --policy ghostapi.policy.yaml --run "${{ steps.run.outputs.evidence_path }}" --out "$RUNNER_TEMP/ghostapi-evidence/report.json" --ci
    else
      ghostapi evidence generate --policy ghostapi.policy.yaml --out "$RUNNER_TEMP/ghostapi-evidence/report.json" --ci
    fi

- name: Upload evidence even on a policy failure
  if: ${{ always() }}
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
  with:
    name: ghostapi-evidence-${{ github.run_id }}-${{ github.run_attempt }}
    path: ${{ runner.temp }}/ghostapi-evidence/report.json
    if-no-files-found: error
    retention-days: 14

- name: Fail the check from the policy result
  if: ${{ always() }}
  run: |
    test "${{ steps.run.outcome }}" = success
    test "${{ steps.evidence.outcome }}" = success
```

Set `GHOSTAPI_DATA_DIR` to a runner-temp directory. `--run` is important: it makes evidence read the isolated run's event log rather than unrelated workspace events. If the launcher failed before creating its run receipt, omit `--run` so GhostAPI still emits a failure artifact with explicit incomplete-evidence warnings. The artifact is sanitized by GhostAPI and contains summaries, categories, counts, and redacted paths rather than raw authorization headers, cookies, request bodies, commands, or policy contents.

`ghostapi run` currently requires a Linux host that passes its user, mount, network, and PID namespace preflight. It fails closed on unavailable platforms or hosts; do not replace it with a proxy-only fallback and call the result enforced.

## Permissions And Comments

The safety job uses only:

```yaml
permissions:
  contents: read
```

The optional comment job is separate, has only `pull-requests: write`, does not check out or run pull request code, and runs only when the pull request head repository equals the base repository. It finds a bot-owned marker comment and updates it, preventing comment spam. The comment contains only the job result and directs reviewers to the check and artifact.

Do not use `pull_request_target` to run GhostAPI or project commands from a pull request. For fork pull requests, use the ordinary `pull_request` event, keep the default read-only token, pass no secrets, and skip comment mutation entirely. GitHub does not provide repository secrets to fork-triggered `pull_request` runs, and its `GITHUB_TOKEN` is read-only there. A maintainer must not move the write token into a job that executes untrusted checkout content.

Configure branch protection (or a ruleset) to require the `Enforced safety check` status check. The workflow also listens to `merge_group` so repositories using GitHub's merge queue receive the required result.

## Included Smoke Fixture

[`examples/ci-smoke`](../examples/ci-smoke) demonstrates both outcomes on a compatible Linux runner:

- `test:safe` sends a synthetic Stripe-shaped request to the namespace-local GhostAPI endpoint and completes the `ci.safe_ghostapi` policy scenario.
- `test:production-egress` attempts a direct connection to `api.stripe.com`; the loopback-only namespace must make that target command fail.

The reference workflow treats the expected unsafe-fixture failure as a successful regression test, then generates the report only from the successful safe run.
