import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getWorldPath, createSyntheticWorld, createWorld, forkWorld, inspectWorld, resetWorld, runSubscriptionFailureWorkflow, SyntheticWorldError, validateSyntheticWorld } from "../src/worlds/index.js";

const workerPath = fileURLToPath(new URL("./fixtures/concurrentWriter.ts", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

describe("synthetic worlds", () => {
  it("generates an identical initial world from the same manifest input and keeps one canonical identity across providers", () => {
    const first = createSyntheticWorld({ id: "billing-world", seed: "fixed-seed", title: "Billing recovery" });
    const second = createSyntheticWorld({ id: "billing-world", seed: "fixed-seed", title: "Billing recovery" });

    expect(first).toEqual(second);
    expect(first.manifest.providerProjections.stripe.personaId).toBe(first.manifest.personas[0]?.id);
    expect(first.manifest.providerProjections.github.organizationId).toBe(first.manifest.organizations[0]?.id);
    expect(first.manifest.providerProjections.email.inboxAddress).toBe(first.manifest.accounts.email.inboxAddress);
    expect(first.manifest.accounts.email.inboxAddress).toMatch(/@ghostapi\.invalid$/);
  });

  it("atomically creates linked Stripe, email, GitHub, and generic REST state for a failed subscription workflow", async () => {
    await createWorld({ id: "workflow-world", seed: "workflow-seed" });
    const receipt = await runSubscriptionFailureWorkflow("workflow-world", "checkout-failed");
    const world = await inspectWorld("workflow-world");

    expect(world.revision).toBe(1);
    expect(world.state.stripe.customers).toEqual([expect.objectContaining({ id: receipt.customerId, personaId: world.manifest.personas[0]?.id })]);
    expect(world.state.stripe.subscriptions).toEqual([expect.objectContaining({ id: receipt.subscriptionId, customerId: receipt.customerId, status: "past_due" })]);
    expect(world.state.email.messages).toEqual([expect.objectContaining({ id: receipt.emailId, relatedSubscriptionId: receipt.subscriptionId, to: world.manifest.accounts.email.inboxAddress })]);
    expect(world.state.github.issues).toEqual([expect.objectContaining({ number: receipt.issueNumber, relatedSubscriptionId: receipt.subscriptionId })]);
    expect(world.state.genericRest.failures).toEqual([expect.objectContaining({ id: receipt.genericFailureId, relatedSubscriptionId: receipt.subscriptionId })]);

    await expect(runSubscriptionFailureWorkflow("workflow-world", "checkout-failed")).resolves.toEqual(receipt);
    expect((await inspectWorld("workflow-world")).state.receipts).toHaveLength(1);
  });

  it("resets to the deterministic baseline and forks the current snapshot without sharing persisted state", async () => {
    await createWorld({ id: "reset-world", seed: "reset-seed" });
    await runSubscriptionFailureWorkflow("reset-world", "first-failure");
    const fork = await forkWorld("reset-world", { id: "reset-world-fork" });
    const reset = await resetWorld("reset-world");

    expect(reset.state).toEqual(reset.baseline);
    expect(fork.manifest.lineage).toEqual({ parentId: "reset-world", parentRevision: 1 });
    expect(fork.state.receipts).toHaveLength(1);
    await runSubscriptionFailureWorkflow("reset-world-fork", "fork-only-failure");
    expect((await inspectWorld("reset-world")).state.receipts).toHaveLength(0);
    expect((await inspectWorld("reset-world-fork")).state.receipts).toHaveLength(2);
  });

  it("preserves concurrent cross-process world transactions without silent lost updates", async () => {
    await createWorld({ id: "concurrent-world", seed: "concurrent-seed" });
    await Promise.all([runWorldWriter("left", 20), runWorldWriter("right", 20)]);
    const world = await inspectWorld("concurrent-world");

    expect(world.state.receipts).toHaveLength(40);
    expect(world.state.stripe.subscriptions).toHaveLength(40);
    expect(world.state.email.messages).toHaveLength(40);
    expect(world.state.github.issues).toHaveLength(40);
    expect(new Set(world.state.receipts.map((receipt) => receipt.actionId))).toHaveLength(40);
  });

  it("rejects secret-shaped and inconsistent world data before use", async () => {
    const world = createSyntheticWorld({ id: "invalid-world", seed: "invalid-seed" });
    expect(() => validateSyntheticWorld({ ...world, manifest: { ...world.manifest, seed: "sk_live_not_allowed" } })).toThrow(SyntheticWorldError);
    expect(() => createSyntheticWorld({ id: "pii-world", seed: "person@example.com" })).toThrow("non-PII");
    expect(() => validateSyntheticWorld({ ...world, manifest: { ...world.manifest, providerProjections: { ...world.manifest.providerProjections, email: { ...world.manifest.providerProjections.email, inboxAddress: "person@example.com" } } } })).toThrow("Provider projections");

    await createWorld({ id: "stored-world", seed: "stored-seed" });
    const path = getWorldPath("stored-world");
    const saved = await readFile(path, "utf8");
    expect(saved).not.toContain("sk_live_");
    expect(saved).toContain("ghostapi.invalid");
  });

  it("executes the documented world CLI lifecycle", async () => {
    const created = await runCli(["world", "create", "--id", "cli-world", "--seed", "cli-seed", "--json"]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ manifest: { id: "cli-world", seed: "cli-seed" } });

    const inspected = await runCli(["world", "inspect", "cli-world", "--json"]);
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({ revision: 0 });

    await runSubscriptionFailureWorkflow("cli-world", "before-reset");
    const reset = await runCli(["world", "reset", "cli-world", "--json"]);
    expect(reset.exitCode).toBe(0);
    expect(JSON.parse(reset.stdout).state.receipts).toEqual([]);

    const forked = await runCli(["world", "fork", "cli-world", "--id", "cli-world-fork", "--json"]);
    expect(forked.exitCode).toBe(0);
    expect(JSON.parse(forked.stdout)).toMatchObject({ manifest: { id: "cli-world-fork", lineage: { parentId: "cli-world" } } });
  }, 30_000);
});

function runWorldWriter(prefix: string, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, "world", prefix, String(count)], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`World writer exited ${code}: ${stderr}`)));
  });
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
