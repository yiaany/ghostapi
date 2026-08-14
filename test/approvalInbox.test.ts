import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalActionGateway } from "../src/actions/index.js";
import { ApprovalInboxError, createLocalApprovalInbox, createTestApprovalApproverVerifier } from "../src/approvals/index.js";
import { getDataPaths } from "../src/config/dataPaths.js";
import { createWorld, inspectWorld } from "../src/worlds/index.js";

const POLICY_HASH = "a".repeat(64);
const EVIDENCE_HASH = "b".repeat(64);

describe("local human approval inbox", () => {
  it("shows normalized impact, requires two independent approvers, and executes an exact action once", async () => {
    const fixture = inboxFixture("two-person");
    await createWorld({ id: "approval-world", seed: "approval-seed" });
    const request = await fixture.inbox.request(action("approval-one", "approval-world"), criticalPolicy(), { confidence: 90, amountMinor: 2500 });
    const alice = fixture.identities.issue({ id: "alice", independenceKey: "alice" });
    const bob = fixture.identities.issue({ id: "bob", independenceKey: "bob" });

    expect(request.risk).toBe("update");
    expect(request.display).toMatchObject({ target: "synthetic-world/approval-world", reversibility: "none", impact: { amountMinor: 2500, amountKnown: true, irreversible: true }, simulation: { status: "passed" } });
    await expect(fixture.inbox.approve(request.id, fixture.identities.issue({ id: "agent-one", independenceKey: "agent-one" }))).rejects.toThrow("cannot approve");
    await fixture.inbox.approve(request.id, alice);
    await expect(fixture.inbox.approve(request.id, fixture.identities.issue({ id: "alice-alt", independenceKey: "alice" }))).rejects.toThrow("only once");
    const approved = await fixture.inbox.approve(request.id, bob);
    expect(approved.status).toBe("approved");
    expect(approved.artifact?.actionHash).toBe(approved.actionHash);

    const receipt = await fixture.inbox.execute(request.id, { actorId: "agent-one", workloadId: "checkout-worker" }, actionPolicy(), criticalPolicy());
    const replay = await fixture.inbox.execute(request.id, { actorId: "agent-one", workloadId: "checkout-worker" }, actionPolicy(), criticalPolicy()).catch((error: unknown) => error);
    const stored = await fixture.inbox.get(request.id);
    const world = await inspectWorld("approval-world");

    expect(receipt.status).toBe("verified");
    expect(replay).toBeInstanceOf(ApprovalInboxError);
    expect(world.state.receipts).toHaveLength(1);
    expect(stored).toMatchObject({ status: "executed", executionReceiptHash: receipt.receiptHash });
    const state = await fixture.inbox.readStateForTesting();
    expect(state.audit.at(-1)).toMatchObject({ event: "execution.verified", requestId: request.id, actionHash: request.actionHash, actionReceiptHash: receipt.receiptHash });
  });

  it("rejects stale/action-mismatched approval artifacts and supports edit-and-resubmit", async () => {
    const fixture = inboxFixture("resubmit");
    await createWorld({ id: "resubmit-a", seed: "resubmit-a" });
    await createWorld({ id: "resubmit-b", seed: "resubmit-b" });
    const original = await fixture.inbox.request(action("resubmit-one", "resubmit-a"), standardPolicy(), { confidence: 99 });
    const reviewer = fixture.identities.issue({ id: "reviewer", independenceKey: "reviewer" });
    const updated = await fixture.inbox.editAndResubmit(original.id, reviewer, action("resubmit-two", "resubmit-b"), standardPolicy(), { confidence: 99 });

    expect((await fixture.inbox.get(original.id)).status).toBe("superseded");
    expect(updated.supersedesRequestId).toBe(original.id);
    await fixture.inbox.approve(updated.id, reviewer);
    await expect(fixture.inbox.execute(original.id, { actorId: "agent-one", workloadId: "checkout-worker" }, actionPolicy(), standardPolicy())).rejects.toThrow("not active");
    await expect(fixture.inbox.execute(updated.id, { actorId: "agent-one", workloadId: "checkout-worker" }, { ...actionPolicy(), hash: "c".repeat(64) }, standardPolicy())).rejects.toThrow("does not match");
  });

  it("fails closed on timeout, reject, policy drift, and insufficient amount evidence", async () => {
    let now = new Date("2026-08-14T12:00:00.000Z");
    const fixture = inboxFixture("timeout", () => now);
    await createWorld({ id: "timeout-world", seed: "timeout-seed" });
    const request = await fixture.inbox.request(action("timeout-one", "timeout-world"), standardPolicy({ approvalTtlMs: 2_000, escalationTimeoutMs: 1_000 }), { confidence: 99 });
    now = new Date("2026-08-14T12:00:02.000Z");
    expect((await fixture.inbox.get(request.id)).status).toBe("timed_out");
    await expect(fixture.inbox.execute(request.id, { actorId: "agent-one", workloadId: "checkout-worker" }, actionPolicy(), standardPolicy({ approvalTtlMs: 2_000, escalationTimeoutMs: 1_000 }))).rejects.toThrow("not active");

    now = new Date("2026-08-14T12:03:00.000Z");
    const rejected = await fixture.inbox.request(action("reject-one", "timeout-world"), standardPolicy(), { confidence: 99 });
    const reviewer = fixture.identities.issue({ id: "reviewer", independenceKey: "reviewer" });
    await fixture.inbox.reject(rejected.id, reviewer, "not safe now");
    await expect(fixture.inbox.execute(rejected.id, { actorId: "agent-one", workloadId: "checkout-worker" }, actionPolicy(), standardPolicy())).rejects.toThrow("not active");
    await expect(fixture.inbox.request(action("amount-one", "timeout-world"), standardPolicy({ maxAmountMinor: 100 }), { confidence: 99 })).rejects.toThrow("amount is missing");
  });

  it("serializes emergency revoke against execution and prevents a revoked artifact from side effects", async () => {
    const fixture = inboxFixture("revoke-race");
    await createWorld({ id: "revoke-world", seed: "revoke-seed" });
    const request = await fixture.inbox.request(action("revoke-one", "revoke-world"), standardPolicy(), { confidence: 99 });
    const reviewer = fixture.identities.issue({ id: "reviewer", independenceKey: "reviewer" });
    await fixture.inbox.approve(request.id, reviewer);
    await fixture.inbox.revoke(request.id, reviewer, "emergency-stop");
    await expect(fixture.inbox.execute(request.id, { actorId: "agent-one", workloadId: "checkout-worker" }, actionPolicy(), standardPolicy())).rejects.toThrow("not active");
    expect((await inspectWorld("revoke-world")).state.receipts).toHaveLength(0);
  });
});

function inboxFixture(name: string, now = () => new Date("2026-08-14T12:00:00.000Z")) {
  const identities = createTestApprovalApproverVerifier();
  const root = getDataPaths().root;
  const gateway = createLocalActionGateway({ now, pathForAction: (actionId) => join(root, "approval-actions", `${actionId}.json`) });
  const inbox = createLocalApprovalInbox({ path: join(root, `approvals-${name}.json`), now, approverVerifier: identities.verifier, actionGateway: gateway });
  return { inbox, identities };
}

function action(actionId: string, worldId: string) {
  return { schemaVersion: 1, kind: "ghostapi.action", actionId, idempotencyKey: `idem-${actionId}`, actor: { id: "agent-one", workloadId: "checkout-worker", type: "agent" as const }, project: { id: "checkout-project", environment: "synthetic" as const }, provider: "ghostapi-synthetic" as const, operation: "synthetic.subscription_failure", resource: { type: "synthetic-world" as const, id: worldId }, arguments: { worldId }, expectedSideEffects: ["stripe.subscription.past_due", "email.subscription_payment_failed", "github.recovery_issue", "generic_rest.payment_failed"], riskClass: "write" as const, reversibility: "none" as const, policy: { version: 1, hash: POLICY_HASH }, evidence: { hash: EVIDENCE_HASH }, expiresAt: "2026-08-14T13:00:00.000Z", nonce: `nonce-${actionId}` };
}

function standardPolicy(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, kind: "ghostapi.approval-policy", id: "local-policy", version: 1, allowedEnvironments: ["synthetic"], minimumConfidence: 80, criticalRisks: [], velocity: { maxActions: 10, windowMs: 60_000 }, approvalTtlMs: 10_000, escalationTimeoutMs: 5_000, ...overrides };
}

function criticalPolicy() { return standardPolicy({ criticalRisks: ["update"] }); }
function actionPolicy() { return { version: 1, hash: POLICY_HASH, allowed: true }; }
