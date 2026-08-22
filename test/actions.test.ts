import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActionGatewayError, actionHash, createLocalActionGateway, createSyntheticActionAdapter, createTestActionApprovalVerifier } from "../src/actions/index.js";
import { createLocalSafetyController, createTestSafetyEmergencyAuthorizer } from "../src/safety/index.js";
import { createWorld, inspectWorld } from "../src/worlds/index.js";

const POLICY_HASH = "a".repeat(64);
const EVIDENCE_HASH = "b".repeat(64);
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";
const cliPath = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const approvalAuthority = createTestActionApprovalVerifier();

describe("synthetic production action gateway", () => {
  it("binds approval to canonical arguments, executes synthetic state exactly once, and writes a receipt chain", async () => {
    await createWorld({ id: "action-world", seed: "action-seed" });
    const action = actionEnvelope("action-one", "action-world");
    const gateway = createGateway();
    const submitted = await gateway.submit(action, approvalFor(action), policy());
    const receipt = await gateway.execute(action, { actorId: "agent-one", workloadId: "checkout-worker" }, policy());
    const replay = await gateway.execute(action, { actorId: "agent-one", workloadId: "checkout-worker" }, policy());
    const stored = await gateway.inspect("action-one");
    const world = await inspectWorld("action-world");

    expect(submitted.receipts[0]?.status).toBe("requested");
    expect(receipt.status).toBe("verified");
    expect(replay).toEqual(receipt);
    expect(world.state.receipts).toHaveLength(1);
    expect(stored.receipts.map((entry) => entry.status)).toEqual(["requested", "attempted", "committed", "verified"]);
    expect(stored.receipts.every((entry, index) => index === 0 || entry.previousReceiptHash === stored.receipts[index - 1]?.receiptHash)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("sk_live_");
  });

  it("blocks mutated arguments after approval and rejects a self-approval", async () => {
    await createWorld({ id: "mutated-world", seed: "mutated-seed" });
    await createWorld({ id: "other-world", seed: "other-seed" });
    const action = actionEnvelope("action-two", "mutated-world");
    const gateway = createGateway();
    await gateway.submit(action, approvalFor(action), policy());

    const mutated = { ...action, resource: { ...action.resource, id: "other-world" }, arguments: { worldId: "other-world" } };
    await expect(gateway.execute(mutated, { actorId: "agent-one", workloadId: "checkout-worker" }, policy())).rejects.toThrow("changed after approval");
    await expect(gateway.submit(actionEnvelope("action-self", "mutated-world"), approvalFor(actionEnvelope("action-self", "mutated-world"), "agent-one"), policy())).rejects.toThrow("cannot approve");
    await expect(gateway.submit(actionEnvelope("action-expired", "mutated-world"), approvalFor(actionEnvelope("action-expired", "mutated-world"), "reviewer-one", { expiresAt: "2028-12-31T23:59:59.000Z" }), policy())).rejects.toThrow("expired");
    await expect(gateway.submit({ ...actionEnvelope("action-expired-envelope", "mutated-world"), expiresAt: "2028-12-31T23:59:59.000Z" }, approvalFor({ ...actionEnvelope("action-expired-envelope", "mutated-world"), expiresAt: "2028-12-31T23:59:59.000Z" }), policy())).rejects.toThrow("Action has expired");
  });

  it("fails closed for unsupported operations, policy/identity drift, and unknown outcomes without retry", async () => {
    await createWorld({ id: "failure-world", seed: "failure-seed" });
    const action = actionEnvelope("action-three", "failure-world");
    const unknownAdapter = { ...createSyntheticActionAdapter(), execute: async () => ({ outcome: "unknown" as const }) };
    const gateway = createGateway(unknownAdapter);
    await gateway.submit(action, approvalFor(action), policy());
    await expect(gateway.execute(action, { actorId: "agent-one", workloadId: "checkout-worker" }, { ...policy(), hash: "c".repeat(64) })).rejects.toThrow("does not match");
    await expect(gateway.execute(action, { actorId: "other-agent", workloadId: "checkout-worker" }, policy())).rejects.toThrow("identity");
    await expect(gateway.execute(action, { actorId: "agent-one", workloadId: "checkout-worker" }, policy())).rejects.toThrow("outcome is unknown");
    await expect(gateway.execute(action, { actorId: "agent-one", workloadId: "checkout-worker" }, policy())).rejects.toThrow("outcome is unknown");
    expect((await gateway.inspect("action-three")).receipts.map((entry) => entry.status)).toEqual(["requested", "attempted", "failed"]);

    const unsupported = { ...action, actionId: "action-four", operation: "synthetic.unknown", expectedSideEffects: [] };
    await gateway.submit(unsupported, approvalFor(unsupported), policy());
    await expect(gateway.execute(unsupported, { actorId: "agent-one", workloadId: "checkout-worker" }, policy())).rejects.toThrow("does not support action operation");
    await expect(gateway.compensate("action-three")).rejects.toThrow("Compensation is unsupported");
  });

  it("rejects tampered persisted receipts", async () => {
    await createWorld({ id: "tampered-world", seed: "tampered-seed" });
    const action = actionEnvelope("action-tampered", "tampered-world");
    const path = join(process.env.GHOSTAPI_DATA_DIR!, "actions", "action-tampered.action.json");
    const gateway = createGateway();
    await gateway.submit(action, approvalFor(action), policy());
    const saved = JSON.parse(await readFile(path, "utf8")) as { receipts: Array<{ status: string }> };
    saved.receipts[0]!.status = "verified";
    await writeFile(path, JSON.stringify(saved), "utf8");
    await expect(gateway.inspect("action-tampered")).rejects.toThrow(ActionGatewayError);
  });

  it("checks the persisted kill switch in the synthetic world's final commit section", async () => {
    await createWorld({ id: "stopped-world", seed: "stopped-seed" });
    const emergency = createTestSafetyEmergencyAuthorizer();
    const stopOperator = emergency.issue({ id: "stop-operator", principalId: "stop-principal", permissions: ["safety.stop"] });
    const controller = createLocalSafetyController({ path: join(process.env.GHOSTAPI_DATA_DIR!, "safety-final-check.json"), now: () => new Date("2029-01-01T00:00:00.000Z"), emergencyAuthorizer: emergency.authorizer });
    const baseAdapter = createSyntheticActionAdapter();
    const adapter = {
      ...baseAdapter,
      async execute(action: Parameters<typeof baseAdapter.execute>[0], controls: Parameters<typeof baseAdapter.execute>[1]) {
        await controller.stop({ identity: stopOperator, scope: { kind: "global" }, reason: "race before synthetic commit" });
        return baseAdapter.execute(action, controls);
      }
    };
    const action = actionEnvelope("action-stopped", "stopped-world");
    const gateway = createGateway(adapter, controller);
    await gateway.submit(action, approvalFor(action), policy());

    await expect(gateway.execute(action, { actorId: "agent-one", workloadId: "checkout-worker" }, policy())).rejects.toThrow("not automatically retried");
    expect((await inspectWorld("stopped-world")).state.receipts).toEqual([]);
    expect((await gateway.inspect("action-stopped")).receipts.map((entry) => entry.status)).toEqual(["requested", "attempted", "failed"]);
  });

  it("does not advertise dead CLI submit or execute commands", async () => {
    const submitted = await runCli(["action", "submit"]);
    const executed = await runCli(["action", "execute"]);
    expect(submitted).toMatchObject({ exitCode: 1 });
    expect(executed).toMatchObject({ exitCode: 1 });
    expect(submitted.stderr).toContain("verifier-backed approval inbox API");
    expect(executed.stderr).toContain("verifier-backed approval inbox API");
  }, 20_000);

  it("accepts a serialized signed approval and rejects forged provenance", async () => {
    await createWorld({ id: "forged-approval-world", seed: "forged-approval-seed" });
    const action = actionEnvelope("action-forged", "forged-approval-world");
    const gateway = createLocalActionGateway({ now: () => new Date("2029-01-01T00:00:00.000Z"), approvalVerifier: approvalAuthority.verifier, pathForAction: (actionId) => join(process.env.GHOSTAPI_DATA_DIR!, "forged-actions", `${actionId}.json`) });
    const serialized = JSON.parse(JSON.stringify(approvalFor(action)));

    await expect(gateway.submit(action, serialized, policy())).resolves.toMatchObject({ actionHash: actionHash(action) });
    const forgedAction = actionEnvelope("action-forged-two", "forged-approval-world");
    await expect(gateway.submit(forgedAction, { ...approvalFor(forgedAction), provenance: { kind: "ghostapi.ed25519-signature", keyId: "test-approval-key", signature: "A".repeat(86) } }, policy())).rejects.toThrow("authenticity could not be verified");
  });

  it("rejects a trusted approval object that was modified after issuance", async () => {
    await createWorld({ id: "tampered-approval-world", seed: "tampered-approval-seed" });
    const action = actionEnvelope("action-tampered-approval", "tampered-approval-world");
    const approval = approvalFor(action);
    approval.approvedBy = "attacker";

    await expect(createGateway().submit(action, approval, policy())).rejects.toThrow("authenticity could not be verified");
  });

  it("re-authenticates persisted approval provenance at execution", async () => {
    await createWorld({ id: "reauth-world", seed: "reauth-seed" });
    const action = actionEnvelope("action-reauth", "reauth-world");
    let verifierAvailable = true;
    const gateway = createLocalActionGateway({
      now: () => new Date("2029-01-01T00:00:00.000Z"),
      approvalVerifier: {
        verify: async (...args) => {
          if (!verifierAvailable) throw new ActionGatewayError("Action approval authenticity could not be verified.");
          return approvalAuthority.verifier.verify(...args);
        }
      },
      pathForAction: (actionId) => join(process.env.GHOSTAPI_DATA_DIR!, "reauth-actions", `${actionId}.json`)
    });
    await gateway.submit(action, approvalFor(action), policy());
    verifierAvailable = false;

    await expect(gateway.execute(action, { actorId: "agent-one", workloadId: "checkout-worker" }, policy())).rejects.toThrow("authenticity could not be verified");
    expect((await inspectWorld("reauth-world")).state.receipts).toEqual([]);
  });
});

function createGateway(adapter = createSyntheticActionAdapter(), safetyController?: ReturnType<typeof createLocalSafetyController>) {
  const root = process.env.GHOSTAPI_DATA_DIR!;
  return createLocalActionGateway({ now: () => new Date("2029-01-01T00:00:00.000Z"), adapter, safetyController, approvalVerifier: approvalAuthority.verifier, pathForAction: (actionId) => join(root, "actions", `${actionId}.action.json`) });
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
    expiresAt: EXPIRES_AT,
    nonce: `nonce-${actionId}`
  } as const;
}

function approvalFor(action: ReturnType<typeof actionEnvelope> | { [key: string]: unknown }, approvedBy = "reviewer-one", overrides: Partial<{ expiresAt: string }> = {}) {
  return approvalAuthority.issue({
    schemaVersion: 1,
    kind: "ghostapi.action-approval",
    approvalId: `approval-${String(action.actionId)}`,
    actionHash: actionHash(action),
    approvedBy,
    approvedAt: "2028-12-31T00:00:00.000Z",
    expiresAt: overrides.expiresAt ?? EXPIRES_AT,
    nonce: `approval-nonce-${String(action.actionId)}`
  });
}

function policy() {
  return { version: 1, hash: POLICY_HASH, allowed: true };
}

function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}
