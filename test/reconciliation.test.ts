import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actionHash, createLocalActionGateway, createSyntheticActionAdapter } from "../src/actions/index.js";
import { createLocalActionLedger, createTestLedgerAccessAuthorizer } from "../src/ledger/index.js";
import { createLocalReconciliationService, createLocalSloController, createTestReconciliationOperatorAuthorizer, createTestSloOperatorAuthorizer, createWorldStateReconciliationProvider } from "../src/reliability/index.js";
import { createWorld, resetWorld } from "../src/worlds/index.js";

const POLICY_HASH = "a".repeat(64);
const EVIDENCE_HASH = "b".repeat(64);
const FIXED_NOW = "2029-01-01T00:00:00.000Z";

describe("local reconciliation service", () => {
  it("classifies committed, unknown, not_committed, and drifted outcomes without retrying", async () => {
    await createWorld({ id: "recon-world-ok", seed: "recon-seed-ok" });
    await createWorld({ id: "recon-world-ambig", seed: "recon-seed-ambig" });
    await createWorld({ id: "recon-world-none", seed: "recon-seed-none" });
    await createWorld({ id: "recon-world-drift", seed: "recon-seed-drift" });

    const gateway = createGateway();
    const committed = actionEnvelope("recon-ok", "recon-world-ok");
    await gateway.submit(committed, approvalFor(committed), policy());
    await gateway.execute(committed, { actorId: "agent-one", workloadId: "checkout-worker" }, policy());

    const ambiguous = actionEnvelope("recon-ambig", "recon-world-ambig");
    await gateway.submit(ambiguous, approvalFor(ambiguous), policy());
    const ambiguousGateway = createGateway({ ...createSyntheticActionAdapter(), execute: async () => ({ outcome: "unknown" as const }) });
    await expect(ambiguousGateway.execute(ambiguous, { actorId: "agent-one", workloadId: "checkout-worker" }, policy())).rejects.toThrow("outcome is unknown");

    const notCommitted = actionEnvelope("recon-none", "recon-world-none");
    await gateway.submit(notCommitted, approvalFor(notCommitted), policy());

    const drifted = actionEnvelope("recon-drift", "recon-world-drift");
    await gateway.submit(drifted, approvalFor(drifted), policy());
    await gateway.execute(drifted, { actorId: "agent-one", workloadId: "checkout-worker" }, policy());
    await resetWorld("recon-world-drift");

    const access = createTestLedgerAccessAuthorizer();
    const capability = access.issue({ tenantId: "recon-tenant", principalId: "operator", permissions: ["append", "read", "export"] });
    const ledger = createLedger(access.authorizer, "recon-ledger.json");
    for (const actionId of ["recon-ok", "recon-ambig", "recon-none", "recon-drift"]) {
      await ledger.recordAction(capability, await gateway.inspect(actionId));
    }

    const { authorizer, issue } = createTestReconciliationOperatorAuthorizer();
    const operator = issue({ id: "recon-ops", principalId: "recon-ops-one", permissions: ["reconciliation.manage", "reconciliation.inspect"] });
    const { authorizer: sloAuthorizer, issue: issueSlo } = createTestSloOperatorAuthorizer();
    const sloOperator = issueSlo({ id: "slo-ops", principalId: "slo-ops-one", permissions: ["slo.inspect"] });
    const sloController = createLocalSloController({ path: sloPath("recon-slo.json"), now: () => new Date(FIXED_NOW), operatorAuthorizer: sloAuthorizer });
    const worldByAction: Record<string, string> = {
      "recon-ok": "recon-world-ok",
      "recon-ambig": "recon-world-ambig",
      "recon-none": "recon-world-none",
      "recon-drift": "recon-world-drift"
    };
    const provider = createWorldStateReconciliationProvider(async (actionId) => worldByAction[actionId] ?? null);
    const service = createLocalReconciliationService({ path: reconPath("recon-state.json"), now: () => new Date(FIXED_NOW), ledger, capability, provider, sloController, operatorAuthorizer: authorizer });

    const report = await service.runReconciliation({ identity: operator });
    expect(report.integrity).toBe("valid");
    expect(report.counts).toEqual({ committed: 1, not_committed: 1, unknown: 1, compensated: 0, drifted: 1 });

    const byId = Object.fromEntries(report.actions.map((action) => [action.actionId, action]));
    expect(byId["recon-ok"]).toMatchObject({ outcome: "committed", retrySafe: false, ledgerIntent: "committed" });
    expect(byId["recon-ambig"]).toMatchObject({ outcome: "unknown", retrySafe: false, ledgerIntent: "ambiguous" });
    expect(byId["recon-none"]).toMatchObject({ outcome: "not_committed", retrySafe: true, ledgerIntent: "not_committed" });
    expect(byId["recon-drift"]).toMatchObject({ outcome: "drifted", retrySafe: false, ledgerIntent: "committed" });

    expect(report.sli.duplicatePrevention).toEqual({ measured: 3, ok: 3, okRateBps: 10_000 });
    expect(report.sli.receiptVerification).toEqual({ measured: 2, ok: 2, okRateBps: 10_000 });
    expect(report.sli.availability).toEqual({ measured: 3, ok: 1, okRateBps: 3_333 });
    expect(report.sli.executionLatency.measured).toBe(2);
    expect(report.findingsOpened).toBe(2);

    const sloState = await sloController.inspect({ identity: sloOperator });
    expect(sloState.sampleCounts.duplicate_prevention).toBe(3);
    expect(sloState.sampleCounts.receipt_verification).toBe(2);
    expect(sloState.sampleCounts.execution_latency).toBe(2);

    const findings = await service.listFindings({ identity: operator });
    expect(findings).toHaveLength(2);
    const driftFinding = findings.find((finding) => finding.classification === "drifted")!;
    const unknownFinding = findings.find((finding) => finding.classification === "unknown")!;
    expect(unknownFinding.actionId).toBe("recon-ambig");
    expect(driftFinding.actionId).toBe("recon-drift");

    const inspectOnly = issue({ id: "recon-ro", principalId: "recon-ro-one", permissions: ["reconciliation.inspect"] });
    await expect(service.resolveDrift({ identity: inspectOnly, findingId: driftFinding.findingId, reason: "provider restored" })).rejects.toThrow("permission");
    await expect(service.resolveUnknown({ identity: operator, findingId: driftFinding.findingId, reason: "wrong kind", evidenceRef: "world:recon-world-drift" })).rejects.toThrow("Only unknown findings");
    await expect(service.resolveDrift({ identity: operator, findingId: unknownFinding.findingId, reason: "wrong kind" })).rejects.toThrow("Only drifted findings");

    const resolvedDrift = await service.resolveDrift({ identity: operator, findingId: driftFinding.findingId, reason: "provider receipt restored after replay" });
    expect(resolvedDrift).toMatchObject({ status: "resolved", resolution: { resolvedBy: "recon-ops-one" } });
    const resolvedUnknown = await service.resolveUnknown({ identity: operator, findingId: unknownFinding.findingId, reason: "confirmed not committed", evidenceRef: "world:recon-world-ambig receipts=0" });
    expect(resolvedUnknown).toMatchObject({ status: "resolved", resolution: { evidenceRef: "world:recon-world-ambig receipts=0" } });
    expect((await service.listFindings({ identity: operator })).every((finding) => finding.status === "resolved")).toBe(true);
  });

  it("does not open findings for actions that never reached the provider and blocks on ledger corruption", async () => {
    await createWorld({ id: "recon-clean-world", seed: "recon-clean-seed" });
    const gateway = createGateway();
    const action = actionEnvelope("recon-clean", "recon-clean-world");
    await gateway.submit(action, approvalFor(action), policy());
    await gateway.execute(action, { actorId: "agent-one", workloadId: "checkout-worker" }, policy());

    const access = createTestLedgerAccessAuthorizer();
    const capability = access.issue({ tenantId: "recon-clean", principalId: "operator", permissions: ["append", "read", "export"] });
    const ledger = createLedger(access.authorizer, "recon-clean-ledger.json");
    await ledger.recordAction(capability, await gateway.inspect("recon-clean"));

    const { authorizer, issue } = createTestReconciliationOperatorAuthorizer();
    const operator = issue({ id: "recon-clean-ops", principalId: "recon-clean-ops-one", permissions: ["reconciliation.manage"] });
    const provider = createWorldStateReconciliationProvider(async (actionId) => actionId === "recon-clean" ? "recon-clean-world" : null);
    const service = createLocalReconciliationService({ path: reconPath("recon-clean-state.json"), now: () => new Date(FIXED_NOW), ledger, capability, provider, operatorAuthorizer: authorizer });
    const report = await service.runReconciliation({ identity: operator });
    expect(report.counts).toEqual({ committed: 1, not_committed: 0, unknown: 0, compensated: 0, drifted: 0 });
    expect(report.findingsOpened).toBe(0);

    const readOnly = issue({ id: "recon-ro", principalId: "recon-ro-one", permissions: ["reconciliation.inspect"] });
    await expect(service.runReconciliation({ identity: readOnly })).rejects.toThrow("permission");

    const path = join(process.env.GHOSTAPI_DATA_DIR!, "recon-clean-ledger.json");
    const modified = JSON.parse(await readFile(path, "utf8")) as { entries: Array<{ data: Record<string, unknown> }> };
    modified.entries[0]!.data.operation = "synthetic.tampered";
    await writeFile(path, JSON.stringify(modified), "utf8");
    await expect(service.runReconciliation({ identity: operator })).rejects.toThrow("integrity verification");
  });
});

function createGateway(adapter = createSyntheticActionAdapter()) {
  const root = process.env.GHOSTAPI_DATA_DIR!;
  return createLocalActionGateway({ now: () => new Date(FIXED_NOW), adapter, pathForAction: (actionId) => join(root, "actions", `${actionId}.action.json`) });
}

function createLedger(authorizer: ReturnType<typeof createTestLedgerAccessAuthorizer>["authorizer"], fileName: string) {
  return createLocalActionLedger({ path: join(process.env.GHOSTAPI_DATA_DIR!, fileName), incidentsPath: join(process.env.GHOSTAPI_DATA_DIR!, `incidents-${fileName}`), now: () => new Date(FIXED_NOW), accessAuthorizer: authorizer });
}

function sloPath(fileName: string): string {
  return join(process.env.GHOSTAPI_DATA_DIR!, fileName);
}

function reconPath(fileName: string): string {
  return join(process.env.GHOSTAPI_DATA_DIR!, fileName);
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