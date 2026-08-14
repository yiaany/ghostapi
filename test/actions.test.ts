import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActionGatewayError, actionHash, createLocalActionGateway, createSyntheticActionAdapter } from "../src/actions/index.js";
import { createWorld, inspectWorld } from "../src/worlds/index.js";

const POLICY_HASH = "a".repeat(64);
const EVIDENCE_HASH = "b".repeat(64);
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";
const cliPath = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

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
    await expect(gateway.submit(actionEnvelope("action-expired", "mutated-world"), { ...approvalFor(actionEnvelope("action-expired", "mutated-world")), expiresAt: "2028-12-31T23:59:59.000Z" }, policy())).rejects.toThrow("expired");
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

  it("submits, inspects, and executes a synthetic action through the CLI", async () => {
    await createWorld({ id: "cli-action-world", seed: "cli-action-seed" });
    const root = process.env.GHOSTAPI_DATA_DIR!;
    const actionPath = join(root, "cli-action.json");
    const approvalPath = join(root, "cli-approval.json");
    const policyPath = "test/fixtures/strict.policy.yaml";
    const policySource = await readFile(fileURLToPath(new URL("./fixtures/strict.policy.yaml", import.meta.url)), "utf8");
    const action = { ...actionEnvelope("cli-action", "cli-action-world"), policy: { version: 1, hash: createHash("sha256").update(policySource, "utf8").digest("hex") } };
    const approval = { ...approvalFor(action), approvedAt: "2026-08-12T00:00:00.000Z" };
    await writeFile(actionPath, JSON.stringify(action), "utf8");
    await writeFile(approvalPath, JSON.stringify(approval), "utf8");

    const submitted = await runCli(["action", "submit", "--action", actionPath, "--approval", approvalPath, "--policy", policyPath, "--json"]);
    expect(submitted.exitCode).toBe(0);
    expect(JSON.parse(submitted.stdout)).toMatchObject({ envelope: { actionId: "cli-action" } });
    const inspected = await runCli(["action", "inspect", "cli-action", "--json"]);
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout).receipts).toHaveLength(1);
    const executed = await runCli(["action", "execute", "--action", actionPath, "--policy", policyPath, "--actor", "agent-one", "--workload", "checkout-worker", "--json"]);
    expect(executed.exitCode).toBe(0);
    expect(JSON.parse(executed.stdout)).toMatchObject({ status: "verified", actionId: "cli-action", providerRequestId: "synthetic_cli-action" });
  }, 20_000);
});

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
    expiresAt: EXPIRES_AT,
    nonce: `nonce-${actionId}`
  } as const;
}

function approvalFor(action: ReturnType<typeof actionEnvelope> | { [key: string]: unknown }, approvedBy = "reviewer-one") {
  return {
    schemaVersion: 1,
    kind: "ghostapi.action-approval",
    approvalId: `approval-${String(action.actionId)}`,
    actionHash: actionHash(action),
    approvedBy,
    approvedAt: "2028-12-31T00:00:00.000Z",
    expiresAt: EXPIRES_AT,
    nonce: `approval-nonce-${String(action.actionId)}`
  };
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
