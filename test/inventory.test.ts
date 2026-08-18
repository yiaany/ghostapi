import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDisabledInventoryOperatorAuthorizer,
  createLocalInventoryController,
  createTestInventoryOperatorAuthorizer,
  validateImportPayload
} from "../src/inventory/index.js";
import type {
  InventoryOperator,
  InventoryOperatorAuthorizer,
  InventoryOperatorPermission,
  LocalInventoryController
} from "../src/inventory/index.js";

const NOW = "2029-01-01T00:00:00.000Z";
const STORED_POLICY_HASH = "a".repeat(64);

describe("local inventory controller", () => {
  it("denies access without operator authorization and starts empty", async () => {
    const disabled = createDisabledInventoryOperatorAuthorizer();
    const controller = createLocalInventoryController({ path: inventoryPath("inv-disabled.json"), now: () => new Date(NOW), operatorAuthorizer: disabled });
    await expect(controller.inspect({})).rejects.toThrow("not configured");

    const { authorizer, issue } = createTestInventoryOperatorAuthorizer();
    const operator = issue({ id: "invop", principalId: "invop-one", tenantId: "tenant-a", permissions: ["inventory.import", "inventory.inspect"] });
    const allowed = createLocalInventoryController({ path: inventoryPath("inv-empty.json"), now: () => new Date(NOW), operatorAuthorizer: authorizer });
    const inspected = await allowed.inspect(operator);
    expect(inspected.agents).toEqual([]);
    expect(inspected.edges).toEqual([]);
    await expect(allowed.inspect({})).rejects.toThrow("not authenticated");
  });

  it("imports records with provenance and refreshes instead of duplicating on re-import", async () => {
    const { controller, operator } = setup({ permissions: ["inventory.import", "inventory.inspect"] });
    const summary = await controller.import(operator, tenantAPayload());
    expect(summary.recordCounts).toMatchObject({ agents: 2, tools: 1, identities: 2, providers: 2, resources: 2, sideEffects: 3, credentials: 2, policies: 1 });
    expect(summary.edgesCreated).toBeGreaterThan(0);

    const snapshot = await controller.inspect(operator);
    expect(snapshot.agents).toHaveLength(2);
    expect(snapshot.credentials).toHaveLength(2);

    const edges = await controller.graph(operator);
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.provenance).toMatchObject({ sourceId: "repo-config", sourceType: "config", importedBy: "invop-one" });
      expect(edge.freshnessStatus).toBe("fresh");
      expect(edge.firstSeenAt).toBe(NOW);
      expect(edge.lastSeenAt).toBe(NOW);
    }

    const reimport = await controller.import(operator, tenantAPayload());
    expect(reimport.edgesCreated).toBe(0);
    expect(reimport.edgesRefreshed).toBeGreaterThan(0);
    const after = await controller.inspect(operator);
    expect(after.agents).toHaveLength(2);
    expect(after.credentials).toHaveLength(2);
    expect(after.edges).toHaveLength(edges.length);
  });

  it("isolates tenant data across the shared store (graph, findings, export, attack paths)", async () => {
    const { controller, operator } = setup({ permissions: ["inventory.import", "inventory.inspect", "inventory.analyze", "inventory.export"] });
    await controller.import(operator, tenantAPayload());
    const graphA = await controller.graph(operator);
    expect(graphA.length).toBeGreaterThan(0);

    const tenantB = issueOperator("tenant-b");
    const controllerB = createLocalInventoryController({ path: controller.path, now: () => new Date(NOW), operatorAuthorizer: tenantB.authorizer });
    await controllerB.import(tenantB.operator, { schemaVersion: 1, kind: "ghostapi.inventory-import", source: { sourceId: "ci-repo", sourceType: "ci", sourceName: "CI" }, counters: { preventedEgressAttempts: 2 } });

    const graphB = await controllerB.graph(tenantB.operator);
    expect(graphB).toEqual([]);
    const exportedB = await controllerB.export(tenantB.operator);
    expect(exportedB.tenantId).toBe("tenant-b");
    expect(exportedB.inventory.agents).toEqual([]);
    expect(exportedB.removalAnalysis.tenantId).toBe("tenant-b");
    expect(exportedB.roi.tenantId).toBe("tenant-b");
    expect((await controllerB.attackPaths(tenantB.operator, "agent-order")).paths).toEqual([]);
    expect((await controllerB.analyze(tenantB.operator)).findings).toBe(0);
  });

  it("computes complete attack paths and a heuristic-labeled blast radius", async () => {
    const { controller, operator } = setup({ permissions: ["inventory.import", "inventory.inspect"] });
    await controller.import(operator, tenantAPayload());

    const attackPaths = await controller.attackPaths(operator, "agent-order");
    const complete = attackPaths.paths.find((path) => path.complete);
    expect(complete).toBeDefined();
    expect(complete!.steps.map((step) => step.kind)).toEqual(["agent", "identity", "tool", "provider", "resource", "side_effect"]);
    expect(complete!.steps[4].id).toBe("resource-payments");
    expect(complete!.edges.length).toBeGreaterThan(0);

    const blast = await controller.blastRadius(operator, "agent-order");
    expect(blast.agentId).toBe("agent-order");
    expect(blast.heuristicNote).toContain("heuristic");
    const payments = blast.resources.find((resource) => resource.resourceId === "resource-payments");
    expect(payments).toBeDefined();
    expect(payments!.sideEffects.every((sideEffect) => sideEffect.heuristic === true)).toBe(true);
    expect(payments!.rules.length).toBeGreaterThan(0);
  });

  it("detects every supported finding kind from the fixture", async () => {
    const { controller, operator } = setup({ permissions: ["inventory.import", "inventory.analyze", "inventory.inspect"] });
    await controller.import(operator, tenantAPayload());
    const { findings } = await controller.analyze(operator);
    expect(findings).toBeGreaterThan(0);
    const snapshot = await controller.inspect(operator);
    const kinds = new Set(snapshot.findings.map((finding) => finding.kind));
    expect(kinds).toEqual(new Set([
      "orphaned_agents",
      "agents_outside_gateway",
      "missing_evidence",
      "missing_kill_switch",
      "unowned_production_integrations",
      "stale_unused_credentials",
      "excessive_permissions",
      "policy_drift"
    ]));

    const heuristic = snapshot.findings.filter((finding) => finding.basis === "heuristic");
    expect(heuristic.length).toBeGreaterThan(0);
    expect(heuristic.every((finding) => finding.kind === "excessive_permissions")).toBe(true);
  });

  it("proposes and applies remediations without ever expanding permissions", async () => {
    const { controller, operator } = setup({ permissions: ["inventory.import", "inventory.analyze", "inventory.remediate", "inventory.inspect"] });
    await controller.import(operator, tenantAPayload());
    await controller.analyze(operator);
    const snapshot = await controller.inspect(operator);
    const excessive = snapshot.findings.find((finding) => finding.kind === "excessive_permissions");
    expect(excessive).toBeDefined();

    const proposed = await controller.proposeRemediation(operator, {
      findingId: excessive!.findingId,
      kind: "reduce_scope",
      targetKind: excessive!.targetKind,
      targetId: excessive!.targetId,
      rationale: "Drop the unused admin scope.",
      reducedScopes: ["read", "charge"]
    });
    expect(proposed.status).toBe("proposed");

    await expect(controller.proposeRemediation(operator, {
      findingId: excessive!.findingId,
      kind: "reduce_scope",
      targetKind: "credential",
      targetId: "cred-stripe",
      rationale: "Tries to expand.",
      reducedScopes: ["read", "charge", "admin", "admin:all"]
    })).rejects.toThrow(/subset/);
    await expect(controller.proposeRemediation(operator, {
      findingId: excessive!.findingId,
      kind: "reduce_scope",
      targetKind: "credential",
      targetId: "cred-stripe",
      rationale: "Removes nothing.",
      reducedScopes: ["read", "charge", "admin"]
    })).rejects.toThrow(/remove at least one/);

    const applied = await controller.applyRemediation(operator, proposed.remediationId);
    expect(applied.status).toBe("applied");
    const credential = (await controller.inspect(operator)).credentials.find((candidate) => candidate.credentialId === "cred-stripe");
    expect(credential!.grantScopes).toEqual(["read", "charge"]);
    await expect(controller.applyRemediation(operator, proposed.remediationId)).rejects.toThrow(/already applied/);

    const orphanFinding = (await controller.inspect(operator)).findings.find((finding) => finding.kind === "orphaned_agents");
    const ownerProposal = await controller.proposeRemediation(operator, {
      findingId: orphanFinding!.findingId,
      kind: "assign_owner",
      targetKind: "agent",
      targetId: "agent-legacy",
      rationale: "Give the legacy agent an owner.",
      ownerId: "sre-one"
    });
    await controller.applyRemediation(operator, ownerProposal.remediationId);
    const legacy = (await controller.inspect(operator)).agents.find((agent) => agent.agentId === "agent-legacy");
    expect(legacy!.ownerId).toBe("sre-one");
  });

  it("exposes a complete open export and a no-invented-savings ROI report", async () => {
    const { controller, operator } = setup({ permissions: ["inventory.import", "inventory.analyze", "inventory.remediate", "inventory.inspect", "inventory.export"] });
    await controller.import(operator, tenantAPayload());
    await controller.analyze(operator);
    const snapshot = await controller.inspect(operator);
    const evidence = snapshot.findings.find((finding) => finding.kind === "missing_evidence");
    const evalProposal = await controller.proposeRemediation(operator, {
      findingId: evidence!.findingId,
      kind: "create_eval",
      targetKind: "agent",
      targetId: "agent-legacy",
      rationale: "Require an evaluation before rollout.",
      evalScenarioId: "eval-safety-baseline"
    });
    await controller.applyRemediation(operator, evalProposal.remediationId);

    const exported = await controller.export(operator);
    expect(exported.tenantId).toBe("tenant-a");
    expect(exported.inventory.agents).toHaveLength(2);
    expect(exported.policyRecords).toHaveLength(1);
    expect(exported.evidenceMetadata).toHaveLength(2);
    const legacyEvidence = exported.evidenceMetadata.find((entry) => entry.agentId === "agent-legacy");
    expect(legacyEvidence!.status).toBe("missing");
    expect(exported.scenarioRefs).toEqual([{ evalScenarioId: "eval-safety-baseline", forFindingId: evidence!.findingId, createdBy: "invop-one" }]);
    expect(exported.roi.basis).toBe("local_inventory_data_only");
    expect(exported.roi.remediationOutcomes.evalsCreated).toBe(1);
    expect(exported.roi.incidents.reviewTimeMinutes).toBeNull();
    expect(exported.roi.incidents.meanTimeToContainMinutes).toBeNull();
    expect(exported.roi.incidents.preventedEgressAttempts).toBe(0);
    expect(exported.roi.notMeasured).toEqual(expect.arrayContaining(["review_time_minutes", "mean_time_to_contain_minutes", "prevented_egress_attempts"]));
  });

  it("uses real counters from gateway/ci imports instead of inventing savings", async () => {
    const { controller, operator } = setup({ permissions: ["inventory.import", "inventory.analyze", "inventory.export"] });
    await controller.import(operator, {
      schemaVersion: 1,
      kind: "ghostapi.inventory-import",
      source: { sourceId: "gateway-edge", sourceType: "gateway", sourceName: "Edge gateway", sourceVersion: "1.2.0" },
      counters: { preventedEgressAttempts: 7, reviewTimeMinutes: 42, meanTimeToContainMinutes: 12 }
    });
    const roi = (await controller.export(operator)).roi;
    expect(roi.incidents.preventedEgressAttempts).toBe(7);
    expect(roi.incidents.reviewTimeMinutes).toBe(42);
    expect(roi.incidents.meanTimeToContainMinutes).toBe(12);
    expect(roi.incidents.preventedEgressSources).toEqual([expect.objectContaining({ sourceId: "gateway-edge", value: 7 })]);
    expect(roi.notMeasured).toEqual([]);
  });

  it("rejects secret-shaped input and invalid payloads", async () => {
    const { controller, operator } = setup({ permissions: ["inventory.import"] });
    await expect(controller.import(operator, tenantAPayloadWith({ agents: [{ ...tenantAPayload().agents![0], name: "sk_live_secret_key_value" }] }))).rejects.toThrow(/invalid/);
    await expect(controller.import(operator, { schemaVersion: 1, kind: "ghostapi.inventory-import", source: { sourceId: "bad-source", sourceType: "config", sourceName: "Config" }, counters: { preventedEgressAttempts: 1 } })).rejects.toThrow(/Counters are only allowed/);
    expect(() => validateImportPayload(tenantAPayload())).not.toThrow();
    await expect(controller.import(operator, { schemaVersion: 1, kind: "ghostapi.inventory-import", source: { sourceId: "bad-source", sourceType: "cloud", sourceName: "Cloud" }, agents: [{ agentId: "agent-bad", name: "Bad", gatewayManaged: true, killSwitchEnabled: true, identityIds: ["identity-missing"], environmentIds: [] }] })).rejects.toThrow(/unknown identity/);
  });
});

function setup({ permissions }: { permissions: InventoryOperatorPermission[] }): { controller: LocalInventoryController; operator: InventoryOperator } {
  const { authorizer, issue } = createTestInventoryOperatorAuthorizer();
  const operator = issue({ id: "invop", principalId: "invop-one", tenantId: "tenant-a", permissions });
  const controller = createLocalInventoryController({ path: inventoryPath("inv-fixture.json"), now: () => new Date(NOW), operatorAuthorizer: authorizer });
  return { controller, operator };
}

function issueOperator(tenantId: string): { authorizer: InventoryOperatorAuthorizer; operator: InventoryOperator } {
  const { authorizer, issue } = createTestInventoryOperatorAuthorizer();
  const operator = issue({ id: "invop", principalId: "invop-one", tenantId, permissions: ["inventory.import", "inventory.inspect", "inventory.analyze", "inventory.export"] });
  return { authorizer, operator };
}

function tenantAPayload() {
  return {
    schemaVersion: 1 as const,
    kind: "ghostapi.inventory-import" as const,
    source: { sourceId: "repo-config", sourceType: "config" as const, sourceName: "Repo config", sourceVersion: "7.0.0" },
    expectedPolicyHashes: [{ environmentId: "production", policyHash: "f".repeat(64) }],
    agents: [
      {
        agentId: "agent-order",
        name: "Order assistant",
        ownerId: "sre-one",
        businessPurpose: "Handles customer orders end to end.",
        model: "gpt-class",
        runtime: "node",
        version: "1.0.0",
        identityIds: ["identity-order"],
        environmentIds: ["production"],
        gatewayManaged: true,
        killSwitchEnabled: true,
        lastEvidenceAt: "2028-12-15T00:00:00.000Z"
      },
      {
        agentId: "agent-legacy",
        name: "Legacy scraper",
        identityIds: ["identity-human"],
        environmentIds: ["production"],
        gatewayManaged: false,
        killSwitchEnabled: false
      }
    ],
    identities: [
      { identityId: "identity-order", principalId: "svc-order", role: "service_account" as const, toolIds: ["tool-stripe"], environmentIds: ["production"], scopes: ["read", "charge"] },
      { identityId: "identity-human", principalId: "sre-one", role: "user" as const, toolIds: [], environmentIds: [], scopes: [] }
    ],
    tools: [{ toolId: "tool-stripe", name: "Stripe SDK", kind: "sdk_client" as const, providerId: "provider-stripe", requiredScopes: ["read", "charge"], credentialIds: ["cred-stripe"] }],
    providers: [
      { providerId: "provider-stripe", name: "Stripe", providerType: "payments", ownerId: "sre-one", environmentIds: ["production"], resourceIds: ["resource-payments"], gatewayBound: true, killSwitchApplied: false },
      { providerId: "provider-saas", name: "Legacy SaaS", providerType: "billing", environmentIds: ["production"], resourceIds: ["resource-saas"], gatewayBound: false, killSwitchApplied: false }
    ],
    resources: [
      { resourceId: "resource-payments", providerId: "provider-stripe", resourceType: "payment", name: "Payments API", environmentIds: ["production"], sensitive: true, ownerId: "sre-one", sideEffectIds: ["side-charge", "side-read"] },
      { resourceId: "resource-saas", providerId: "provider-saas", resourceType: "account", name: "SaaS accounts", environmentIds: ["production"], sensitive: false, sideEffectIds: ["side-write"] }
    ],
    sideEffects: [
      { sideEffectId: "side-charge", resourceId: "resource-payments", kind: "money_movement" as const, severity: "critical" as const },
      { sideEffectId: "side-read", resourceId: "resource-payments", kind: "read" as const, severity: "low" as const },
      { sideEffectId: "side-write", resourceId: "resource-saas", kind: "update" as const, severity: "medium" as const }
    ],
    credentials: [
      { credentialId: "cred-stripe", name: "Stripe live key", providerId: "provider-stripe", environmentIds: ["production"], grantScopes: ["read", "charge", "admin"], toolIds: ["tool-stripe"], status: "active" as const, issuedAt: "2028-01-01T00:00:00.000Z", gatewayBound: true },
      { credentialId: "cred-retired", name: "Retired key", providerId: "provider-stripe", environmentIds: ["production"], grantScopes: ["read"], toolIds: [], status: "revoked" as const, issuedAt: "2027-01-01T00:00:00.000Z", gatewayBound: false }
    ],
    policies: [{ policyId: "policy-prod", name: "Production policy", version: "3.2.1", hash: STORED_POLICY_HASH, environmentIds: ["production"] }]
  };
}

function tenantAPayloadWith(overrides: { agents: unknown[] }): ReturnType<typeof tenantAPayload> {
  return { ...tenantAPayload(), ...overrides };
}

function inventoryPath(fileName: string): string {
  return join(process.env.GHOSTAPI_DATA_DIR!, fileName);
}