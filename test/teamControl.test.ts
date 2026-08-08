import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDataPaths } from "../src/config/dataPaths.js";
import { buildEvidenceReport } from "../src/evidence/index.js";
import { createDisabledIdentityProvider, createLocalTeamControlPlane, createTeamControlPlaneSecurityHeaders, migrateTeamControlPlane, TeamControlPlaneError, TeamControlPlaneRateLimiter, TEAM_CONTROL_PLANE_SECURITY_HEADERS, TEAM_PERMISSION_MATRIX, verifyAuditExport } from "../src/teamControl/index.js";

describe("local team control-plane security prototype", () => {
  it("enforces tenant boundaries and the owner/admin/developer/viewer permission matrix", async () => {
    const plane = teamPlane("roles");
    const owner = { organizationId: "roles-a", memberId: "owner" };
    const otherOwner = { organizationId: "roles-b", memberId: "owner-b" };
    const admin = { organizationId: "roles-a", memberId: "admin" };
    const developer = { organizationId: "roles-a", memberId: "developer" };
    const viewer = { organizationId: "roles-a", memberId: "viewer" };
    await plane.bootstrapOrganization({ organizationId: "roles-a", name: "Roles A", ownerId: "owner" });
    await plane.bootstrapOrganization({ organizationId: "roles-b", name: "Roles B", ownerId: "owner-b" });
    await plane.addMember(owner, { memberId: "admin", role: "admin" });
    await plane.addMember(owner, { memberId: "developer", role: "developer" });
    await plane.addMember(owner, { memberId: "viewer", role: "viewer" });
    await prepareProject(plane, owner, "project", "ci");

    await expect(plane.addMember(admin, { memberId: "blocked", role: "viewer" })).rejects.toThrow("Access denied");
    const ownerToken = await plane.issueToken(owner, { expiresAt: "2026-08-09T00:00:00.000Z" });
    await expect(plane.issueToken(admin, { memberId: "owner", expiresAt: "2026-08-09T00:00:00.000Z" })).rejects.toThrow("Access denied");
    await expect(plane.rotateToken(admin, ownerToken.tokenId)).rejects.toThrow("Access denied");
    await expect(plane.revokeToken(admin, ownerToken.tokenId)).rejects.toThrow("Access denied");
    await expect(plane.registerProject(developer, { projectId: "blocked", name: "Blocked" })).rejects.toThrow("Access denied");
    await expect(plane.publishScenario(viewer, scenario("project", "ci", "blocked"))).rejects.toThrow("Access denied");
    await expect(plane.listAudit(developer)).rejects.toThrow("Access denied");
    await expect(plane.registerProject(admin, { projectId: "admin-project", name: "Admin Project" })).resolves.toMatchObject({ id: "admin-project" });
    await expect(plane.publishScenario(developer, scenario("project", "ci", "allowed"))).resolves.toMatchObject({ createdBy: "developer" });
    await expect(plane.listScenarioVersions(viewer, { projectId: "project", environmentId: "ci", scenarioId: "allowed" })).resolves.toHaveLength(1);
    await expect(plane.listScenarioVersions(otherOwner, { projectId: "project", environmentId: "ci", scenarioId: "allowed" })).rejects.toThrow("Resource not found");
  });

  it("persists hash-only typed service tokens and enforces their scope on every scoped operation", async () => {
    const plane = teamPlane("service");
    const owner = { organizationId: "service-team", memberId: "owner" };
    await plane.bootstrapOrganization({ organizationId: "service-team", name: "Service Team", ownerId: "owner" });
    await prepareProject(plane, owner, "project-a", "ci-a");
    await prepareProject(plane, owner, "project-b", "ci-b");
    await plane.createServiceAccount(owner, { serviceAccountId: "ci-bot", name: "CI bot" });
    const issued = await plane.issueServiceToken(owner, {
      serviceAccountId: "ci-bot",
      expiresAt: "2026-08-09T00:00:00.000Z",
      scope: [{ projectId: "project-a", environmentId: "ci-a", permissions: ["scenario.publish", "evidence.upload", "scenario.read", "evidence.read"] }]
    });
    const service = await plane.authenticateToken(issued.token);
    const stored = await readFile(join(getDataPaths().root, "team-control-service.json"), "utf8");
    expect(stored).not.toContain(issued.token);
    expect(stored).toContain("digest");
    await expect(plane.publishScenario(service, scenario("project-a", "ci-a", "service-flow"))).resolves.toMatchObject({ createdBy: "service:ci-bot" });
    await expect(plane.uploadSanitizedEvidence(service, { evidenceId: "service-evidence", projectId: "project-a", environmentId: "ci-a", report: evidenceReport() })).resolves.toMatchObject({ uploadedBy: "service:ci-bot" });
    await expect(plane.publishScenario(service, scenario("project-b", "ci-b", "outside-scope"))).rejects.toThrow("Access denied");
    await expect(plane.registerProject(service, { projectId: "blocked", name: "Blocked" })).rejects.toThrow("Access denied");
    await expect(plane.getLatestPolicy(service)).rejects.toThrow("Access denied");
    await expect(plane.publishScenario({ organizationId: "service-team", serviceAccountId: "ci-bot", actorType: "service_account", tokenId: issued.tokenId }, scenario("project-a", "ci-a", "forged-service-actor"))).rejects.toThrow("Access denied");
  });

  it("rotates atomically, revokes old credentials, rejects expiry, and blocks service impersonation", async () => {
    let now = new Date("2026-08-08T00:00:00.000Z");
    const plane = createLocalTeamControlPlane({ path: join(getDataPaths().root, "team-control-rotation.json"), now: () => now });
    const owner = { organizationId: "rotation-team", memberId: "owner" };
    await plane.bootstrapOrganization({ organizationId: "rotation-team", name: "Rotation Team", ownerId: "owner" });
    const issued = await plane.issueToken(owner, { expiresAt: "2026-08-09T00:00:00.000Z" });
    const rotated = await plane.rotateToken(owner, issued.tokenId);
    await expect(plane.authenticateToken(issued.token)).rejects.toThrow("Invalid or expired token");
    await expect(plane.authenticateToken(rotated.token)).resolves.toEqual(owner);
    now = new Date("2026-08-10T00:00:00.000Z");
    await expect(plane.authenticateToken(rotated.token)).rejects.toThrow("Invalid or expired token");
    await expect(plane.issueToken({ organizationId: "rotation-team", serviceAccountId: "not-human", actorType: "service_account", tokenId: "tok_missing" }, { expiresAt: "2026-08-11T00:00:00.000Z" })).rejects.toThrow("Access denied");
  });

  it("freezes published role permissions and bounds duplicate token allocation", async () => {
    expect(Object.isFrozen(TEAM_PERMISSION_MATRIX.owner)).toBe(true);
    const plane = createLocalTeamControlPlane({ path: join(getDataPaths().root, "team-control-collision.json"), randomTokenBytes: (size) => Buffer.alloc(size, 5) });
    const owner = { organizationId: "collision-team", memberId: "owner" };
    await plane.bootstrapOrganization({ organizationId: "collision-team", name: "Collision Team", ownerId: "owner" });
    await plane.issueToken(owner, { expiresAt: "2026-08-09T00:00:00.000Z" });
    await expect(plane.issueToken(owner, { expiresAt: "2026-08-09T00:00:00.000Z" })).rejects.toThrow("Unable to allocate a unique token");
  });

  it("expires and disables authenticated service accounts before every side effect", async () => {
    let now = new Date("2026-08-08T00:00:00.000Z");
    const plane = createLocalTeamControlPlane({ path: join(getDataPaths().root, "team-control-disable.json"), now: () => now });
    const owner = { organizationId: "disable-team", memberId: "owner" };
    await plane.bootstrapOrganization({ organizationId: "disable-team", name: "Disable Team", ownerId: "owner" });
    await prepareProject(plane, owner, "project", "ci");
    await plane.createServiceAccount(owner, { serviceAccountId: "ci-bot", name: "CI bot" });
    const issued = await plane.issueServiceToken(owner, { serviceAccountId: "ci-bot", expiresAt: "2026-08-09T00:00:00.000Z", scope: [{ projectId: "project", environmentId: "ci", permissions: ["scenario.publish"] }] });
    const service = await plane.authenticateToken(issued.token);
    now = new Date("2026-08-10T00:00:00.000Z");
    await expect(plane.publishScenario(service, scenario("project", "ci", "expired"))).rejects.toThrow("Access denied");

    now = new Date("2026-08-08T12:00:00.000Z");
    const active = await plane.issueServiceToken(owner, { serviceAccountId: "ci-bot", expiresAt: "2026-08-09T12:00:00.000Z", scope: [{ projectId: "project", environmentId: "ci", permissions: ["scenario.publish"] }] });
    const activeService = await plane.authenticateToken(active.token);
    await plane.disableServiceAccount(owner, "ci-bot");
    await expect(plane.publishScenario(activeService, scenario("project", "ci", "disabled"))).rejects.toThrow("Access denied");
    await expect(plane.authenticateToken(active.token)).rejects.toThrow("Invalid or expired token");
  });

  it("exports a SHA-256 audit chain that detects public-export tampering and retains a safe anchor", async () => {
    let now = new Date("2026-08-08T00:00:00.000Z");
    const path = join(getDataPaths().root, "team-control-audit.json");
    const plane = createLocalTeamControlPlane({ path, now: () => now });
    const owner = { organizationId: "audit-team", memberId: "owner" };
    await plane.bootstrapOrganization({ organizationId: "audit-team", name: "Audit Team", ownerId: "owner" });
    await plane.registerProject(owner, { projectId: "project", name: "Project" });
    const exported = await plane.exportAudit(owner);
    expect(exported.integrity).toEqual({ valid: true });
    expect(JSON.stringify(exported)).not.toContain("gapi_team_");
    expect(verifyAuditExport({ ...exported, records: [{ ...exported.records[0]!, action: "tampered" }, ...exported.records.slice(1)] }).valid).toBe(false);
    now = new Date("2026-11-10T00:00:00.000Z");
    await plane.pruneRetention(owner);
    expect((await plane.exportAudit(owner)).integrity.valid).toBe(true);
    const persisted = JSON.parse(await readFile(path, "utf8")) as { audit: Array<{ action: string }> };
    persisted.audit[0]!.action = "tampered";
    await writeFile(path, JSON.stringify(persisted), "utf8");
    await expect(plane.listAudit(owner)).rejects.toThrow("Audit chain is invalid");
  });

  it("deletes only tenant-bound evidence and preserves resource-not-found IDOR semantics", async () => {
    const plane = teamPlane("delete");
    const ownerA = { organizationId: "delete-a", memberId: "owner-a" };
    const ownerB = { organizationId: "delete-b", memberId: "owner-b" };
    await plane.bootstrapOrganization({ organizationId: "delete-a", name: "Delete A", ownerId: "owner-a" });
    await plane.bootstrapOrganization({ organizationId: "delete-b", name: "Delete B", ownerId: "owner-b" });
    await prepareProject(plane, ownerA, "project", "ci");
    await plane.uploadSanitizedEvidence(ownerA, { evidenceId: "evidence", projectId: "project", environmentId: "ci", report: evidenceReport() });
    await expect(plane.deleteEvidence(ownerB, { projectId: "project", evidenceId: "evidence" })).rejects.toThrow("Resource not found");
    await expect(plane.deleteEvidence(ownerA, { projectId: "project", evidenceId: "evidence" })).resolves.toBeUndefined();
    await expect(plane.listEvidence(ownerA, "project")).resolves.toEqual([]);
    await expect(plane.deleteProject(ownerA, "project")).resolves.toBeUndefined();
    await expect(plane.listProjects(ownerA)).resolves.toEqual([]);
  });

  it("migrates v1 and v2 safely and validates future transport controls fail closed", async () => {
    expect(migrateTeamControlPlane({ schemaVersion: 1, organizations: [], members: [], projects: [], environments: [], tokens: [], scenarios: [], evidence: [], policies: [] })).toMatchObject({ schemaVersion: 3, serviceAccounts: [], auditAnchors: [] });
    expect(migrateTeamControlPlane({ schemaVersion: 2, organizations: [], members: [], projects: [], environments: [], tokens: [], scenarios: [], evidence: [], policies: [], audit: [] })).toMatchObject({ schemaVersion: 3, serviceAccounts: [], auditAnchors: [] });
    await expect(createDisabledIdentityProvider().authenticate()).rejects.toThrow("not configured");
    expect(TEAM_CONTROL_PLANE_SECURITY_HEADERS["content-security-policy"]).toContain("default-src 'none'");
    expect(createTeamControlPlaneSecurityHeaders()).not.toBe(TEAM_CONTROL_PLANE_SECURITY_HEADERS);
    let tick = 0;
    const limiter = new TeamControlPlaneRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 1, now: () => new Date(tick) });
    expect(limiter.consume("client").remaining).toBe(0);
    expect(() => limiter.consume("client")).toThrow("Rate limit exceeded");
    expect(() => limiter.consume("second-client")).toThrow("capacity exceeded");
    expect(() => limiter.consume("sk_live_rate_limit_key")).toThrow("key is invalid");
    tick = 1_001;
    expect(limiter.consume("client").remaining).toBe(0);
    expect(() => new TeamControlPlaneRateLimiter({ limit: 0 })).toThrow(TeamControlPlaneError);
    const badClock = new TeamControlPlaneRateLimiter({ now: () => new Date("invalid") });
    expect(() => badClock.consume("client")).toThrow("clock is invalid");
  });
});

function teamPlane(name: string) {
  return createLocalTeamControlPlane({ path: join(getDataPaths().root, `team-control-${name}.json`), now: () => new Date("2026-08-08T00:00:00.000Z"), randomTokenBytes: (size) => Buffer.alloc(size, 7) });
}

async function prepareProject(plane: ReturnType<typeof createLocalTeamControlPlane>, owner: { organizationId: string; memberId: string }, projectId: string, environmentId: string): Promise<void> {
  await plane.registerProject(owner, { projectId, name: `Project ${projectId}` });
  await plane.createEnvironment(owner, { environmentId, projectId, name: "CI", kind: "ci" });
}

function scenario(projectId: string, environmentId: string, scenarioId: string) {
  return { projectId, environmentId, scenarioId, version: 1, title: scenarioId, metadata: { provider: "stripe" } };
}

function evidenceReport() {
  return buildEvidenceReport({
    events: [{ id: "event-1", timestamp: "2026-08-08T00:00:00.000Z", provider: "stripe", method: "POST", path: "/v1/payment_intents", statusCode: 200, source: "state", durationMs: 1, request: { body: { scenario: "stripe.retry" } }, response: { object: "payment_intent" } }],
    runEvidence: { schemaVersion: 1, runId: "run_1", backend: "linux-network-namespace", status: "finished", events: [{ type: "run-created", timestamp: "2026-08-08T00:00:00.000Z" }, { type: "target-exited", timestamp: "2026-08-08T00:00:01.000Z", exitCode: 0 }] },
    generatedAt: "2026-08-08T00:00:02.000Z", ghostApiVersion: "0.1.7-test"
  });
}
