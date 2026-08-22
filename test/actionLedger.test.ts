import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actionHash, createLocalActionGateway, createSyntheticActionAdapter, createTestActionApprovalVerifier } from "../src/actions/index.js";
import { createLocalActionLedger, createTestLedgerAccessAuthorizer } from "../src/ledger/index.js";
import { createWorld } from "../src/worlds/index.js";

const POLICY_HASH = "a".repeat(64);
const EVIDENCE_HASH = "b".repeat(64);
const approvalAuthority = createTestActionApprovalVerifier();

describe("local action ledger and incident replay", () => {
  it("chains action intent, approval, outcome, and verification while exporting only the tenant scope", async () => {
    await createWorld({ id: "ledger-world", seed: "ledger-seed" });
    const gateway = createGateway();
    const action = actionEnvelope("ledger-action", "ledger-world");
    await gateway.submit(action, approvalFor(action), policy());
    await gateway.execute(action, { actorId: "agent-one", workloadId: "checkout-worker" }, policy());
    const access = createTestLedgerAccessAuthorizer();
    const tenantA = access.issue({ tenantId: "tenant-a", principalId: "auditor-a", permissions: ["append", "read", "export", "manage_retention", "manage_hold", "request_deletion"] });
    const tenantB = access.issue({ tenantId: "tenant-b", principalId: "auditor-b", permissions: ["append", "read", "export"] });
    const ledger = createLedger(access.authorizer, "tenant-ledger.json");

    await ledger.recordAction(tenantA, await gateway.inspect("ledger-action"));
    await createWorld({ id: "ledger-world-b", seed: "ledger-seed-b" });
    const actionB = actionEnvelope("ledger-action-b", "ledger-world-b");
    await gateway.submit(actionB, approvalFor(actionB), policy());
    await ledger.recordAction(tenantB, await gateway.inspect("ledger-action-b"));

    const timeline = await ledger.timeline(tenantA, "ledger-action");
    const exported = await ledger.exportTenant(tenantA);
    expect(timeline.map((entry) => entry.stage)).toEqual(["intent", "identity", "policy_decision", "approval", "credential_grant", "execution_attempt", "provider_receipt", "verification", "compensation"]);
    expect(timeline.find((entry) => entry.stage === "verification")?.data.status).toBe("verified");
    expect(exported.integrity.valid).toBe(true);
    expect(exported.entries).toHaveLength(timeline.length);
    expect(JSON.stringify(exported)).not.toContain("tenant-b");
    expect(JSON.stringify(exported)).not.toMatch(/authorization|cookie|token|secret|email|phone|address|sk_live_/i);
  });

  it("detects modified or deleted ledger entries", async () => {
    await createWorld({ id: "corrupt-ledger-world", seed: "corrupt-ledger-seed" });
    const gateway = createGateway();
    const action = actionEnvelope("corrupt-ledger-action", "corrupt-ledger-world");
    await gateway.submit(action, approvalFor(action), policy());
    const access = createTestLedgerAccessAuthorizer();
    const capability = access.issue({ tenantId: "tenant-corrupt", principalId: "auditor", permissions: ["append", "read"] });
    const ledger = createLedger(access.authorizer, "corrupt-ledger.json");
    await ledger.recordAction(capability, await gateway.inspect("corrupt-ledger-action"));
    const path = join(process.env.GHOSTAPI_DATA_DIR!, "corrupt-ledger.json");
    const modified = JSON.parse(await readFile(path, "utf8")) as { entries: Array<{ data: Record<string, unknown> }> };
    modified.entries[0]!.data.operation = "synthetic.tampered";
    await writeFile(path, JSON.stringify(modified), "utf8");
    expect(await ledger.verifyTenant(capability)).toMatchObject({ valid: false });

    await writeFile(path, JSON.stringify({ ...modified, entries: modified.entries.slice(1) }), "utf8");
    expect(await ledger.verifyTenant(capability)).toMatchObject({ valid: false });
  });

  it("turns an ambiguous action into a local deterministic regression fixture without network or credentials", async () => {
    await createWorld({ id: "incident-world", seed: "incident-seed" });
    const unknownAdapter = { ...createSyntheticActionAdapter(), execute: async () => ({ outcome: "unknown" as const }) };
    const gateway = createGateway(unknownAdapter);
    const action = actionEnvelope("incident-action", "incident-world");
    await gateway.submit(action, approvalFor(action), policy());
    await expect(gateway.execute(action, { actorId: "agent-one", workloadId: "checkout-worker" }, policy())).rejects.toThrow("outcome is unknown");
    const access = createTestLedgerAccessAuthorizer();
    const capability = access.issue({ tenantId: "tenant-incident", principalId: "investigator", permissions: ["append", "read"] });
    const ledger = createLedger(access.authorizer, "incident-ledger.json");
    await ledger.recordAction(capability, await gateway.inspect("incident-action"));

    const incident = await ledger.createIncidentFixture(capability, "incident-action");
    const replay = await ledger.replayIncidentFixture(capability, incident.fixture);
    expect(incident.fixture.expected).toEqual({ status: 409, outcome: "requires_reconciliation" });
    expect(replay).toEqual({ status: 409, outcome: "requires_reconciliation", remaining: 0 });
    expect(JSON.stringify(incident.fixture)).not.toMatch(/authorization|cookie|token|secret|email|phone|address|sk_live_/i);
  });

  it("keeps deletion a recorded request, blocks it under a local legal hold, and does not silently prune history", async () => {
    const access = createTestLedgerAccessAuthorizer();
    const capability = access.issue({ tenantId: "tenant-governance", principalId: "records-owner", permissions: ["manage_retention", "manage_hold", "request_deletion", "read", "export"] });
    const ledger = createLedger(access.authorizer, "governance-ledger.json");
    await ledger.configureRetention(capability, 30);
    await ledger.setLegalHold(capability, true);
    await expect(ledger.requestDeletion(capability)).rejects.toThrow("legal hold");
    await ledger.setLegalHold(capability, false);
    const state = await ledger.requestDeletion(capability);
    expect(state.deletionRequestedAt).toBe("2029-01-01T00:00:00.000Z");
    expect((await ledger.exportTenant(capability)).entries.map((entry) => entry.stage)).toEqual(["retention", "legal_hold", "legal_hold", "deletion_request"]);
  });

  it("marks policy and approval echoes as caller-claimed and reports untracked tenants as not tracked", async () => {
    await createWorld({ id: "basis-world", seed: "basis-seed" });
    const gateway = createGateway();
    const action = actionEnvelope("basis-action", "basis-world");
    await gateway.submit(action, approvalFor(action), policy());
    const access = createTestLedgerAccessAuthorizer();
    const capability = access.issue({ tenantId: "tenant-basis", principalId: "auditor", permissions: ["append", "read", "export"] });
    const ledger = createLedger(access.authorizer, "basis-ledger.json");
    await ledger.recordAction(capability, await gateway.inspect("basis-action"));
    const timeline = await ledger.timeline(capability, "basis-action");
    expect(timeline.find((entry) => entry.stage === "policy_decision")?.data.basis).toBe("caller_claimed");
    expect(timeline.find((entry) => entry.stage === "approval")?.data.basis).toBe("caller_claimed");
    expect(await ledger.verifyTenant(capability)).toMatchObject({ valid: true, tracked: true });
    expect(await ledger.verifyTenant(access.issue({ tenantId: "tenant-unknown", principalId: "auditor", permissions: ["read"] }))).toEqual({ valid: true, entryCount: 0, headHash: sha256("ghostapi.action-ledger.v1:tenant-unknown"), tracked: false });
  });

  it("rotates expired tenant history at the entry limit and relinks the surviving chain without breaking integrity", async () => {
    const access = createTestLedgerAccessAuthorizer();
    const capability = access.issue({ tenantId: "tenant-rotation", principalId: "records-owner", permissions: ["append", "read", "export"] });
    const ledger = createLedger(access.authorizer, "rotation-ledger.json");
    const path = join(process.env.GHOSTAPI_DATA_DIR!, "rotation-ledger.json");
    const seeded = seedLedgerState("tenant-rotation", 2_000, 1_500);
    await writeFile(path, JSON.stringify(seeded), "utf8");
    await createWorld({ id: "rotation-world", seed: "rotation-seed" });
    const gateway = createGateway();
    const action = actionEnvelope("rotation-action", "rotation-world");
    await gateway.submit(action, approvalFor(action), policy());
    await ledger.recordAction(capability, await gateway.inspect("rotation-action"));
    const verification = await ledger.verifyTenant(capability);
    expect(verification).toMatchObject({ valid: true, tracked: true });
    expect(verification.entryCount).toBeGreaterThan(500);
    expect(verification.entryCount).toBeLessThan(2_000);
    const exported = await ledger.exportTenant(capability);
    expect(exported.entries.some((entry) => entry.actionId === "seed-action-1")).toBe(false);
    expect(exported.entries.some((entry) => entry.actionId === "seed-action-2000")).toBe(true);
  });
});

function seedLedgerState(tenantId: string, count: number, oldCount: number) {
  const entries = [];
  let previousHash = sha256(`ghostapi.action-ledger.v1:${tenantId}`);
  for (let index = 1; index <= count; index += 1) {
    const base = { schemaVersion: 1, kind: "ghostapi.action-ledger-entry", tenantId, sequence: index, timestamp: index <= oldCount ? "2028-01-01T00:00:00.000Z" : "2029-01-01T00:00:00.000Z", actionId: `seed-action-${index}`, actionHash: "c".repeat(64), stage: "intent" as const, data: { operation: "synthetic.op" }, previousHash };
    const entryHash = sha256(canonicalJson(base));
    entries.push({ ...base, entryHash });
    previousHash = entryHash;
  }
  return { schemaVersion: 1, kind: "ghostapi.action-ledger", entries, tenants: [{ tenantId, entryCount: count, headHash: previousHash, retentionDays: 1, legalHold: false }] };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new Error("Ledger values must be JSON data.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createLedger(authorizer: ReturnType<typeof createTestLedgerAccessAuthorizer>["authorizer"], fileName: string) {
  return createLocalActionLedger({ path: join(process.env.GHOSTAPI_DATA_DIR!, fileName), incidentsPath: join(process.env.GHOSTAPI_DATA_DIR!, `incidents-${fileName}`), now: () => new Date("2029-01-01T00:00:00.000Z"), accessAuthorizer: authorizer });
}

function createGateway(adapter = createSyntheticActionAdapter()) {
  const root = process.env.GHOSTAPI_DATA_DIR!;
  return createLocalActionGateway({ now: () => new Date("2029-01-01T00:00:00.000Z"), adapter, approvalVerifier: approvalAuthority.verifier, pathForAction: (actionId) => join(root, "actions", `${actionId}.action.json`) });
}

function actionEnvelope(actionId: string, worldId: string) {
  return {
    schemaVersion: 1,
    kind: "ghostapi.action",
    actionId,
    idempotencyKey: `idem-${actionId}`,
    actor: { id: "agent-one", workloadId: "checkout-worker", type: "agent" },
    project: { id: "checkout-project", environment: "synthetic" },
    provider: "ghostapi-synthetic",
    operation: "synthetic.subscription_failure",
    resource: { type: "synthetic-world", id: worldId },
    arguments: { worldId },
    expectedSideEffects: ["stripe.subscription.past_due", "email.subscription_payment_failed", "github.recovery_issue", "generic_rest.payment_failed"],
    riskClass: "write",
    reversibility: "none",
    policy: { version: 1, hash: POLICY_HASH },
    evidence: { hash: EVIDENCE_HASH },
    expiresAt: "2030-01-01T00:00:00.000Z",
    nonce: `nonce-${actionId}`
  } as const;
}

function approvalFor(action: ReturnType<typeof actionEnvelope>) {
  return approvalAuthority.issue({ schemaVersion: 1, kind: "ghostapi.action-approval", approvalId: `approval-${action.actionId}`, actionHash: actionHash(action), approvedBy: "reviewer-one", approvedAt: "2028-12-31T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", nonce: `approval-nonce-${action.actionId}` } as const);
}

function policy() {
  return { version: 1, hash: POLICY_HASH, allowed: true };
}
