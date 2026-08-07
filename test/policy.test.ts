import { describe, expect, it } from "vitest";
import { evaluatePolicy, formatPolicyDecision, loadPolicyFile, parsePolicyYaml, PolicyValidationError } from "../src/policy/index.js";

const POLICY = `version: 1
network:
  default: deny
  allow:
    - host: localhost
    - host: 127.0.0.1
    - provider: stripe
  deny:
    - host: api.stripe.com
  productionHosts:
    - '*.stripe.com'
credentials:
  forbid:
    - sk_live_*
    - ghp_*
requiredScenarios:
  - stripe.card_declined
enforcement:
  allowedModes:
    - linux-network-namespace
reports:
  maxProductionEgressAttempts: 0
  maxForbiddenCredentialMatches: 0
`;

describe("policy parser", () => {
  it("parses the versioned schema and rejects unknown fields, versions, aliases, and interpolation", () => {
    expect(parsePolicyYaml(POLICY)).toMatchObject({ version: 1, network: { default: "deny" } });
    expect(() => parsePolicyYaml(POLICY.replace("version: 1", "version: 2"))).toThrow("policy.version");
    expect(() => parsePolicyYaml(POLICY.replace("network:\n", "network:\n  unexpected: true\n"))).toThrow("policy.network.unexpected");
    expect(() => parsePolicyYaml(POLICY.replace("host: localhost", "host: &loopback localhost\n    - host: *loopback"))).toThrow("anchors and aliases");
    expect(() => parsePolicyYaml(POLICY.replace("localhost", "${GHOSTAPI_HOST}"))).toThrow("interpolation");
  });

  it("limits input size and reports path-aware validation errors", () => {
    expect(() => parsePolicyYaml(`${POLICY}\n#${"x".repeat(128 * 1024)}`)).toThrow("policy: exceeds");
    expect(() => parsePolicyYaml(POLICY.replace("maxProductionEgressAttempts: 0", "maxProductionEgressAttempts: -1"))).toThrow("policy.reports.maxProductionEgressAttempts");
  });

  it("rejects policy path traversal and symlink-free missing files predictably", async () => {
    await expect(loadPolicyFile("../outside.yaml", process.cwd(), true)).rejects.toThrow("path traversal");
    await expect(loadPolicyFile("missing-policy-for-test.yaml", process.cwd())).resolves.toBeNull();
  });
});

describe("policy evaluation", () => {
  it("gives deny rules deterministic precedence and explains the result", () => {
    const policy = parsePolicyYaml(POLICY);
    const denied = evaluatePolicy(policy, { type: "network", host: "api.stripe.com", provider: "stripe" });
    const allowed = evaluatePolicy(policy, { type: "network", host: "localhost" });

    expect(denied).toMatchObject({ allowed: false, reason: expect.stringContaining("deny rule") });
    expect(denied.trace).toContain("matched network.deny host:api.stripe.com");
    expect(allowed.allowed).toBe(true);
    expect(formatPolicyDecision(denied)).toContain("Decision: DENY");
  });

  it("evaluates credentials, scenarios, enforcement modes, and report thresholds without side effects", () => {
    const policy = parsePolicyYaml(POLICY);
    expect(evaluatePolicy(policy, { type: "credential", value: "sk_live_secret" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, { type: "credential", value: "sk_test_local" }).allowed).toBe(true);
    expect(evaluatePolicy(policy, { type: "scenario", scenarioId: "stripe.card_declined", completedScenarioIds: [] }).allowed).toBe(false);
    expect(evaluatePolicy(policy, { type: "scenario", scenarioId: "stripe.card_declined", completedScenarioIds: ["stripe.card_declined"] }).allowed).toBe(true);
    expect(evaluatePolicy(policy, { type: "enforcement", mode: "proxy-guidance" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, { type: "report", productionEgressAttempts: 1, forbiddenCredentialMatches: 0 }).allowed).toBe(false);
    expect(evaluatePolicy(policy, { type: "report", productionEgressAttempts: 0, forbiddenCredentialMatches: 0, breakingContractChanges: 1 }).allowed).toBe(false);
  });

  it("loads a policy once from a bounded local file", async () => {
    const loaded = await loadPolicyFile("test/fixtures/strict.policy.yaml", process.cwd(), true);
    expect(loaded).not.toBeNull();
    expect(loaded?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded?.policy.requiredScenarios).toEqual(["stripe.card_declined"]);
  });

  it("uses a typed validation error contract", () => {
    expect(() => parsePolicyYaml("version: 1")).toThrow(PolicyValidationError);
  });
});
