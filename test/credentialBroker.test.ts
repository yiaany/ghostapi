import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDataPaths } from "../src/config/dataPaths.js";
import {
  createCredentialBroker,
  createTestActionReceiptVerifier,
  createTestBreakGlassAuthorizer,
  createTestCredentialExecutor,
  createTestCredentialVault,
  createTestWorkloadIdentityProvider,
} from "../src/credentials/index.js";

describe("credential broker and workload identity", () => {
  it("executes server-side without returning or persisting the upstream secret", async () => {
    const fixture = brokerFixture("server-side");
    const secret = testSecretBytes();
    fixture.vault.put("test-vault/checkout", secret);
    await fixture.broker.registerCredential(credential());
    const workload = fixture.identities.issue(identity());
    const grant = await fixture.broker.issueGrant({
      identity: workload,
      request: request(),
      expiresAt: "2026-08-14T12:10:00.000Z",
    });
    const receipt = await fixture.broker.executeServerSide({
      identity: workload,
      grantId: grant.id,
      request: request(),
    });
    const persisted = await readFile(
      join(getDataPaths().root, "credential-broker-server-side.json"),
      "utf8",
    );

    expect(receipt).toMatchObject({ status: "executed", action: action() });
    expect(fixture.executor.executions).toEqual([
      { grantId: grant.id, secretLength: secret.byteLength },
    ]);
    expect(JSON.stringify(grant)).not.toContain(Array.from(secret).join(","));
    expect(JSON.stringify(receipt)).not.toContain(Array.from(secret).join(","));
    expect(persisted).not.toContain(Array.from(secret).join(","));
  });

  it("rejects expired, revoked, and rotated grants before vault or executor use", async () => {
    let now = new Date("2026-08-14T12:00:00.000Z");
    const fixture = brokerFixture("lifecycle", () => now);
    fixture.vault.put("test-vault/checkout", testSecretBytes());
    fixture.vault.put("test-vault/checkout-v2", new Uint8Array(32).fill(8));
    await fixture.broker.registerCredential(credential());
    const workload = fixture.identities.issue(identity());
    const expired = await fixture.broker.issueGrant({
      identity: workload,
      request: request(),
      expiresAt: "2026-08-14T12:01:00.000Z",
    });
    now = new Date("2026-08-14T12:02:00.000Z");
    await expect(
      fixture.broker.executeServerSide({
        identity: workload,
        grantId: expired.id,
        request: request(),
      }),
    ).rejects.toThrow("expired or revoked");

    const revokable = await fixture.broker.issueGrant({
      identity: workload,
      request: request(),
      expiresAt: "2026-08-14T12:10:00.000Z",
    });
    await fixture.broker.revokeCredential("tenant-a", "stripe-write");
    await expect(
      fixture.broker.executeServerSide({
        identity: workload,
        grantId: revokable.id,
        request: request(),
      }),
    ).rejects.toThrow("expired or revoked");
    expect(fixture.executor.executions).toEqual([]);

    const rotated = brokerFixture("rotation", () => now);
    rotated.vault.put("test-vault/checkout", testSecretBytes());
    rotated.vault.put("test-vault/checkout-v2", new Uint8Array(32).fill(8));
    await rotated.broker.registerCredential(credential());
    const rotatedWorkload = rotated.identities.issue(identity());
    const oldGrant = await rotated.broker.issueGrant({
      identity: rotatedWorkload,
      request: request(),
      expiresAt: "2026-08-14T12:10:00.000Z",
    });
    await rotated.broker.rotateCredential({
      tenantId: "tenant-a",
      credentialId: "stripe-write",
      vaultRef: "test-vault/checkout-v2",
      expiresAt: "2026-08-15T12:00:00.000Z",
    });
    await expect(
      rotated.broker.executeServerSide({
        identity: rotatedWorkload,
        grantId: oldGrant.id,
        request: request(),
      }),
    ).rejects.toThrow("expired or revoked");
    expect(rotated.executor.executions).toEqual([]);
  });

  it("enforces tenant, workload, scope, audience, action receipt, and break-glass boundaries", async () => {
    const fixture = brokerFixture("boundaries");
    fixture.vault.put("test-vault/checkout", testSecretBytes());
    await fixture.broker.registerCredential(credential());
    const owner = fixture.identities.issue(identity());
    const crossTenant = fixture.identities.issue({
      ...identity(),
      tenantId: "tenant-b",
      workloadId: "tenant-b-worker",
      subjectId: "tenant-b-agent",
      runId: "run-b",
    });
    const ci = fixture.identities.issue({
      ...identity(),
      workloadKind: "ci_job",
      workloadId: "ci-worker",
      subjectId: "ci-bot",
      runId: "ci-run",
    });

    await expect(
      fixture.broker.issueGrant({
        identity: crossTenant,
        request: request(),
        expiresAt: "2026-08-14T12:10:00.000Z",
      }),
    ).rejects.toThrow("not found");
    await expect(
      fixture.broker.issueGrant({
        identity: owner,
        request: { ...request(), scopes: ["test-other"] },
        expiresAt: "2026-08-14T12:10:00.000Z",
      }),
    ).rejects.toThrow("scope");
    await expect(
      fixture.broker.issueGrant({
        identity: owner,
        request: { ...request(), audience: "not-server" as "ghostapi-server" },
        expiresAt: "2026-08-14T12:10:00.000Z",
      }),
    ).rejects.toThrow("audience");
    await expect(
      fixture.broker.issueGrant({
        identity: ci,
        request: request(),
        expiresAt: "2026-08-14T12:10:00.000Z",
      }),
    ).rejects.toThrow("Break-glass authorization is not configured");

    const breakGlass = createTestBreakGlassAuthorizer({ now: fixture.now });
    const broker = createCredentialBroker({
      ...fixture.options,
      breakGlassAuthorizer: breakGlass.authorizer,
    });
    const approval = breakGlass.issue({
      approvalId: "approval-one",
      action: action(),
      approvedBy: "reviewer-one",
      reason: "incident-recovery",
      issuedAt: "2026-08-14T12:00:00.000Z",
      expiresAt: "2026-08-14T12:04:00.000Z",
    });
    const approvedGrant = await broker.issueGrant({
      identity: ci,
      request: request(),
      expiresAt: "2026-08-14T12:04:00.000Z",
      breakGlassApproval: approval,
    });
    await expect(
      broker.executeServerSide({
        identity: ci,
        grantId: approvedGrant.id,
        request: {
          ...request(),
          action: { ...action(), actionReceiptHash: "b".repeat(64) },
        },
      }),
    ).rejects.toThrow("differs from the granted action");
    await expect(
      broker.executeServerSide({
        identity: ci,
        grantId: approvedGrant.id,
        request: request(),
      }),
    ).resolves.toMatchObject({ status: "executed" });

    const executorBoundary = brokerFixture("executor-scope");
    executorBoundary.vault.put("test-vault/checkout", testSecretBytes());
    await executorBoundary.broker.registerCredential({
      ...credential(),
      allowedScopes: ["test.execute", "test-extra"],
    });
    const executorWorkload = executorBoundary.identities.issue(identity());
    const executorGrant = await executorBoundary.broker.issueGrant({
      identity: executorWorkload,
      request: { ...request(), scopes: ["test-extra"] },
      expiresAt: "2026-08-14T12:10:00.000Z",
    });
    await expect(
      executorBoundary.broker.executeServerSide({
        identity: executorWorkload,
        grantId: executorGrant.id,
        request: { ...request(), scopes: ["test-extra"] },
      }),
    ).rejects.toThrow("executor denies the requested scope");
  });

  it("binds grants to the authenticated subject and run", async () => {
    const fixture = brokerFixture("subject-run-binding");
    fixture.vault.put("test-vault/checkout", testSecretBytes());
    await fixture.broker.registerCredential(credential());
    const owner = fixture.identities.issue(identity());
    const grant = await fixture.broker.issueGrant({
      identity: owner,
      request: request(),
      expiresAt: "2026-08-14T12:10:00.000Z",
    });
    const otherSubject = fixture.identities.issue({
      ...identity(),
      subjectId: "agent-two",
      runId: "run-two",
    });

    expect(grant).toMatchObject({ subjectId: "agent-one", runId: "run-one" });
    await expect(
      fixture.broker.executeServerSide({
        identity: otherSubject,
        grantId: grant.id,
        request: request(),
      }),
    ).rejects.toThrow("subject and run");
    expect(fixture.executor.executions).toEqual([]);
  });

  it("records failed server-side use, returns idempotent executed receipts, and detects orphaned workloads", async () => {
    const fixture = brokerFixture("execution");
    fixture.vault.put("test-vault/checkout", testSecretBytes());
    await fixture.broker.registerCredential(credential());
    const workload = fixture.identities.issue(identity());
    const grant = await fixture.broker.issueGrant({
      identity: workload,
      request: request(),
      expiresAt: "2026-08-14T12:10:00.000Z",
    });
    const first = await fixture.broker.executeServerSide({
      identity: workload,
      grantId: grant.id,
      request: request(),
    });
    const replay = await fixture.broker.executeServerSide({
      identity: workload,
      grantId: grant.id,
      request: request(),
    });
    expect(replay).toEqual(first);
    expect(fixture.executor.executions).toHaveLength(1);

    fixture.identities.deactivate("checkout-worker");
    await expect(
      fixture.broker.listOrphanedCredentials(),
    ).resolves.toMatchObject([{ id: "stripe-write" }]);
  });

  it("records an executor error as an unknown outcome and never automatically retries the same grant", async () => {
    const fixture = brokerFixture("failed-execution");
    fixture.vault.put("test-vault/checkout", testSecretBytes());
    const failingBroker = createCredentialBroker({
      ...fixture.options,
      executor: {
        provider: "test-provider",
        supportsScope: (scope) => scope === "test.execute",
        async execute() {
          throw new Error("provider timeout");
        },
      },
    });
    await failingBroker.registerCredential(credential());
    const workload = fixture.identities.issue(identity());
    const grant = await failingBroker.issueGrant({
      identity: workload,
      request: request(),
      expiresAt: "2026-08-14T12:10:00.000Z",
    });

    await expect(
      failingBroker.executeServerSide({
        identity: workload,
        grantId: grant.id,
        request: request(),
      }),
    ).rejects.toThrow("outcome is unknown");
    await expect(
      failingBroker.executeServerSide({
        identity: workload,
        grantId: grant.id,
        request: request(),
      }),
    ).rejects.toThrow("will not retry automatically");
    expect((await failingBroker.readStateForTesting()).receipts).toMatchObject([
      { grantId: grant.id, status: "unknown", failureCode: "unknown_outcome" },
    ]);
  });

  it("persists revoke while an executor is waiting and blocks its final pre-side-effect check", async () => {
    const fixture = brokerFixture("revoke-race");
    fixture.vault.put("test-vault/checkout", testSecretBytes());
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const enteredExecutor = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseExecutor = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = createCredentialBroker({
      ...fixture.options,
      executor: {
        provider: "test-provider",
        supportsScope: (scope) => scope === "test.execute",
        async execute(input) {
          entered?.();
          await releaseExecutor;
          await input.assertActive();
          return { providerRequestId: "should-not-execute" };
        },
      },
    });
    await broker.registerCredential(credential());
    const workload = fixture.identities.issue(identity());
    const grant = await broker.issueGrant({
      identity: workload,
      request: request(),
      expiresAt: "2026-08-14T12:10:00.000Z",
    });
    const execution = broker.executeServerSide({
      identity: workload,
      grantId: grant.id,
      request: request(),
    });

    await enteredExecutor;
    await broker.revokeCredential("tenant-a", "stripe-write");
    release?.();

    await expect(execution).rejects.toThrow("outcome is unknown");
    expect((await broker.readStateForTesting()).receipts).toMatchObject([
      { grantId: grant.id, status: "unknown", failureCode: "unknown_outcome" },
    ]);
  });
});

function brokerFixture(
  name: string,
  now = () => new Date("2026-08-14T12:00:00.000Z"),
) {
  const vault = createTestCredentialVault();
  const executor = createTestCredentialExecutor();
  const identities = createTestWorkloadIdentityProvider({ now });
  const actionReceipt = createTestActionReceiptVerifier(action());
  const options = {
    path: join(getDataPaths().root, `credential-broker-${name}.json`),
    now,
    vault: vault.vault,
    executor: executor.executor,
    workloadVerifier: identities.verifier,
    actionReceiptVerifier: actionReceipt.verifier,
  };
  return {
    broker: createCredentialBroker(options),
    vault,
    executor,
    identities,
    options,
    now,
  };
}

function credential() {
  return {
    id: "stripe-write",
    tenantId: "tenant-a",
    projectId: "checkout-project",
    environment: "production",
    provider: "test-provider",
    ownerWorkloadId: "checkout-worker",
    ownerWorkloadKind: "agent_run" as const,
    vaultRef: "test-vault/checkout",
    allowedScopes: ["test.execute"],
    expiresAt: "2026-08-15T12:00:00.000Z",
  };
}

function identity() {
  return {
    tenantId: "tenant-a",
    projectId: "checkout-project",
    environment: "production",
    workloadId: "checkout-worker",
    subjectId: "agent-one",
    workloadKind: "agent_run" as const,
    runId: "run-one",
    issuedAt: "2026-08-14T12:00:00.000Z",
    expiresAt: "2026-08-14T12:15:00.000Z",
  };
}

function action() {
  return {
    actionId: "action-one",
    actionHash: "a".repeat(64),
    actionReceiptHash: "c".repeat(64),
  };
}

function request() {
  return {
    credentialId: "stripe-write",
    provider: "test-provider",
    scopes: ["test.execute"],
    audience: "ghostapi-server" as const,
    action: action(),
  };
}

function testSecretBytes() {
  return new Uint8Array(32).fill(7);
}
