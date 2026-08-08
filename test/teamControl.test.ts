import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDataPaths } from "../src/config/dataPaths.js";
import { buildEvidenceReport } from "../src/evidence/index.js";
import { createLocalTeamControlPlane, migrateTeamControlPlane, TeamControlPlaneError } from "../src/teamControl/index.js";

describe("local team control-plane prototype", () => {
  it("enforces organization boundaries for projects, scenarios, evidence, policies, and audit data", async () => {
    const plane = createLocalTeamControlPlane({ randomTokenBytes: (size) => Buffer.alloc(size, 7) });
    const ownerA = { organizationId: "tenant-a", memberId: "owner-a" };
    const ownerB = { organizationId: "tenant-b", memberId: "owner-b" };
    await plane.bootstrapOrganization({ organizationId: "tenant-a", name: "Tenant A", ownerId: "owner-a" });
    await plane.bootstrapOrganization({ organizationId: "tenant-b", name: "Tenant B", ownerId: "owner-b" });
    await plane.registerProject(ownerA, { projectId: "project-a", name: "Project A" });
    await plane.createEnvironment(ownerA, { environmentId: "ci-a", projectId: "project-a", name: "CI", kind: "ci" });
    await plane.publishScenario(ownerA, { projectId: "project-a", environmentId: "ci-a", scenarioId: "retry-flow", version: 1, title: "Retry flow", metadata: { provider: "stripe", review: "required" } });
    await plane.uploadSanitizedEvidence(ownerA, { evidenceId: "evidence-a", projectId: "project-a", environmentId: "ci-a", report: evidenceReport() });
    await plane.distributePolicy(ownerA, { version: 1, policy: policy() });

    await expect(plane.registerProject(ownerB, { projectId: "project-a", name: "Tenant B Project A" })).resolves.toMatchObject({ organizationId: "tenant-b", id: "project-a" });

    await expect(plane.listEvidence(ownerB, "project-a")).resolves.toEqual([]);
    await expect(plane.listScenarioVersions(ownerB, { projectId: "project-a", environmentId: "ci-a", scenarioId: "retry-flow" })).rejects.toThrow("Resource not found");
    await expect(plane.listAudit(ownerB)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ organizationId: "tenant-b" })]));
    await expect(plane.getLatestPolicy(ownerB)).resolves.toBeNull();
  });

  it("stores only a token digest and rejects a revoked token", async () => {
    const plane = createLocalTeamControlPlane({ randomTokenBytes: (size) => Buffer.alloc(size, 9) });
    const owner = { organizationId: "token-team", memberId: "owner" };
    await plane.bootstrapOrganization({ organizationId: "token-team", name: "Token Team", ownerId: "owner" });
    const issued = await plane.issueToken(owner, { expiresAt: "2026-08-09T00:00:00.000Z" });

    await expect(plane.authenticateToken(issued.token)).resolves.toEqual(owner);
    const stored = await readFile(getDataPaths().teamControlPlane, "utf8");
    expect(stored).not.toContain(issued.token);
    expect(stored).toContain("digest");

    await plane.revokeToken(owner, issued.tokenId);
    await expect(plane.authenticateToken(issued.token)).rejects.toThrow("Invalid or expired token");
    await expect(plane.listAudit(owner)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: "owner", action: "token.issue" }),
      expect.objectContaining({ actorId: "owner", action: "token.revoke" })
    ]));
  });

  it("accepts a hash-validated sanitized evidence report and rejects corrupted evidence", async () => {
    const plane = createLocalTeamControlPlane();
    const owner = { organizationId: "evidence-team", memberId: "owner" };
    await plane.bootstrapOrganization({ organizationId: "evidence-team", name: "Evidence Team", ownerId: "owner" });
    await plane.registerProject(owner, { projectId: "evidence-project", name: "Evidence Project" });
    await plane.createEnvironment(owner, { environmentId: "evidence-ci", projectId: "evidence-project", name: "CI", kind: "ci" });
    const report = evidenceReport();
    const uploaded = await plane.uploadSanitizedEvidence(owner, { evidenceId: "evidence-1", projectId: "evidence-project", environmentId: "evidence-ci", report });

    expect(uploaded).toMatchObject({ evidenceHash: report.artifact.logicalHash, runId: "run_1", providers: ["stripe"] });
    await expect(plane.uploadSanitizedEvidence(owner, { evidenceId: "evidence-2", projectId: "evidence-project", environmentId: "evidence-ci", report: { ...report, summary: { ...report.summary, passed: !report.summary.passed } } })).rejects.toThrow("logical hash");
  });

  it("migrates schema v1 stores and applies evidence retention without losing tenant validation", async () => {
    const migrated = migrateTeamControlPlane({ schemaVersion: 1, organizations: [], members: [], projects: [], environments: [], tokens: [], scenarios: [], evidence: [], policies: [] });
    expect(migrated).toMatchObject({ schemaVersion: 2, audit: [] });

    let now = new Date("2026-08-08T00:00:00.000Z");
    const path = join(getDataPaths().root, "retention-team.json");
    const plane = createLocalTeamControlPlane({ path, now: () => now });
    const owner = { organizationId: "retention-team", memberId: "owner" };
    await plane.bootstrapOrganization({ organizationId: "retention-team", name: "Retention Team", ownerId: "owner" });
    await plane.registerProject(owner, { projectId: "retention-project", name: "Retention Project" });
    await plane.createEnvironment(owner, { environmentId: "retention-ci", projectId: "retention-project", name: "CI", kind: "ci" });
    await plane.uploadSanitizedEvidence(owner, { evidenceId: "evidence-old", projectId: "retention-project", environmentId: "retention-ci", report: evidenceReport() });
    now = new Date("2026-09-08T00:00:00.000Z");

    await expect(plane.pruneRetention(owner)).resolves.toMatchObject({ evidenceRemoved: 1 });
    await expect(plane.listEvidence(owner, "retention-project")).resolves.toEqual([]);
  });

  it("rejects unsafe scenario metadata and non-admin project registration", async () => {
    const plane = createLocalTeamControlPlane();
    const owner = { organizationId: "safe-team", memberId: "owner" };
    await plane.bootstrapOrganization({ organizationId: "safe-team", name: "Safe Team", ownerId: "owner" });
    await plane.addMember(owner, { memberId: "member", role: "member" });
    await expect(plane.registerProject({ organizationId: "safe-team", memberId: "member" }, { projectId: "blocked-project", name: "Blocked" })).rejects.toThrow("Access denied");
    await plane.registerProject(owner, { projectId: "safe-project", name: "Safe Project" });
    await plane.createEnvironment(owner, { environmentId: "safe-ci", projectId: "safe-project", name: "CI", kind: "ci" });
    await expect(plane.publishScenario(owner, { projectId: "safe-project", environmentId: "safe-ci", scenarioId: "unsafe-scenario", version: 1, title: "Unsafe", metadata: { authorization: "Bearer secret" } })).rejects.toBeInstanceOf(TeamControlPlaneError);
  });
});

function evidenceReport() {
  return buildEvidenceReport({
    events: [{
      id: "event-1",
      timestamp: "2026-08-08T00:00:00.000Z",
      provider: "stripe",
      method: "POST",
      path: "/v1/payment_intents",
      statusCode: 200,
      source: "state",
      durationMs: 1,
      request: { body: { scenario: "stripe.retry" } },
      response: { object: "payment_intent" }
    }],
    runEvidence: { schemaVersion: 1, runId: "run_1", backend: "linux-network-namespace", status: "finished", events: [{ type: "run-created", timestamp: "2026-08-08T00:00:00.000Z" }, { type: "target-exited", timestamp: "2026-08-08T00:00:01.000Z", exitCode: 0 }] },
    generatedAt: "2026-08-08T00:00:02.000Z",
    ghostApiVersion: "0.1.7-test"
  });
}

function policy() {
  return {
    version: 1 as const,
    network: { default: "deny" as const, allow: [], deny: [], productionHosts: [] },
    credentials: { forbid: [] },
    requiredScenarios: [],
    enforcement: { allowedModes: ["linux-network-namespace" as const] },
    reports: { maxProductionEgressAttempts: 0, maxForbiddenCredentialMatches: 0, maxBreakingContractChanges: 0 }
  };
}
