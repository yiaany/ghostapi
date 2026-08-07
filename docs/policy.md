# Policy As Code

GhostAPI reads one local, versioned YAML policy. It has no remote includes, environment-variable interpolation, templates, or executable expressions.

Copy [`examples/policy/ghostapi.policy.yaml`](../examples/policy/ghostapi.policy.yaml) into a project as `ghostapi.policy.yaml`, then validate it:

```bash
ghostapi policy validate
ghostapi policy explain network api.stripe.com --provider stripe
ghostapi policy explain stripe.card_declined
ghostapi policy explain report 0 0 0
```

`ghostapi run --policy ghostapi.policy.yaml -- <command>` loads and validates the file once before any namespace preflight or target spawn. The run evidence records only the policy SHA-256 and required scenario IDs, not policy file content or command arguments. Policy changes during a run do not reload or alter that run.

`ghostapi evidence generate --policy ghostapi.policy.yaml --ci` evaluates required scenarios and report thresholds against the generated evidence artifact. Pass `--contract-baseline` and `--contract-candidate` to include contract drift. CI mode exits non-zero when required scenarios are missing, production-egress, forbidden-credential, or breaking-contract thresholds are exceeded, or other fail findings are present.

## Schema V1

```yaml
version: 1
network:
  default: deny
  allow:
    - host: localhost
    - provider: stripe
  deny:
    - host: api.stripe.com
  productionHosts:
    - '*.stripe.com'
credentials:
  forbid:
    - sk_live_*
requiredScenarios:
  - stripe-payment-intent-card-declined
enforcement:
  allowedModes:
  - linux-network-namespace
reports:
  maxProductionEgressAttempts: 0
  maxForbiddenCredentialMatches: 0
  maxBreakingContractChanges: 0
```

- `network.default`: `allow` or `deny` when no rule matches.
- `network.allow` and `network.deny`: rules contain exactly one `host` or `provider` field.
- `network.productionHosts`: classifies hostnames for decision traces and CI/report evaluation.
- `credentials.forbid`: bounded `*` globs matched against an explicit input; GhostAPI never expands environment variables in policy.
- `requiredScenarios`: scenario IDs the evidence report must mark complete.
- `enforcement.allowedModes`: currently `linux-network-namespace` or `proxy-guidance`.
- `reports`: maximum allowed production-egress attempts, forbidden-credential matches, and breaking contract changes for a report decision. `maxBreakingContractChanges` defaults to `0` when omitted by an existing policy.

## Precedence And Limits

For a network decision, a matching `network.deny` rule always wins over a matching `network.allow` rule. Otherwise `network.default` decides. `ghostapi policy explain` prints the selected rule and decision trace.

Policies are limited to 128 KiB and list fields to 200 entries. Unknown fields, duplicate YAML keys, unsupported versions, anchors/aliases, interpolation syntax, path traversal, symlink policy files and multiple YAML documents are rejected with a path-aware error.

## Migration

Schema versions are exact. GhostAPI does not coerce or silently upgrade an unknown version. A future version must add an explicit migration command that reads one known old version, emits a new file for review, and requires a separate validation step. It must never rewrite a policy while `ghostapi run` is active.
