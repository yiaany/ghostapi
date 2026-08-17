import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actionHash, createLocalActionGateway, createSyntheticActionAdapter } from "../src/actions/index.js";
import { createLocalActionLedger, createTestLedgerAccessAuthorizer } from "../src/ledger/index.js";
import { createWorld } from "../src/worlds/index.js";

const POLICY_HASH = "a".repeat(64);
const EVIDENCE_HASH = "b".repeat(64);

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
});

function createLedger(authorizer: ReturnType<typeof createTestLedgerAccessAuthorizer>["authorizer"], fileName: string) {
  return createLocalActionLedger({ path: join(process.env.GHOSTAPI_DATA_DIR!, fileName), incidentsPath: join(process.env.GHOSTAPI_DATA_DIR!, `incidents-${fileName}`), now: () => new Date("2029-01-01T00:00:00.000Z"), accessAuthorizer: authorizer });
}

function createGateway(adapter = createSyntheticActionAdapter()) {
  const root = process.env.GHOSTAPI_DATA_DIR!;
  return createLocalActionGateway({ now: () => new Date("2029-01-01T00:00:00.000Z"), adapter, pathForAction: (actionId) => join(root, "actions", `${actionId}.action.json`) });
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
  return { schemaVersion: 1, kind: "ghostapi.action-approval", approvalId: `approval-${action.actionId}`, actionHash: actionHash(action), approvedBy: "reviewer-one", approvedAt: "2028-12-31T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", nonce: `approval-nonce-${action.actionId}` } as const;
}

function policy() {
  return { version: 1, hash: POLICY_HASH, allowed: true };
}
