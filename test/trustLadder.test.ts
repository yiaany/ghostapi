import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDataPaths } from "../src/config/dataPaths.js";
import {
  TrustLadderError,
  createLocalSyntheticTrustCapabilities,
  createLocalTrustLadder,
  createTestTrustOwnerVerifier,
} from "../src/trust/index.js";

const ACTION_HASH = "a".repeat(64);
const CONTEXT_HASH = "b".repeat(64);
const OUTCOME_HASH = "c".repeat(64);
const RECEIPT_HASH = "d".repeat(64);

describe("local synthetic trust ladder", () => {
  it("defines every trust level, keeps dry-run/trusted unsupported, and never enables external side effects", () => {
    const capabilities = createLocalSyntheticTrustCapabilities();

    expect(capabilities.levels.map((capability) => capability.level)).toEqual([
      "simulate",
      "shadow",
      "dry-run",
      "approve",
      "bounded-auto",
      "trusted",
    ]);
    expect(
      capabilities.levels.every(
        (capability) => capability.externalSideEffects === false,
      ),
    ).toBe(true);
    expect(
      capabilities.levels.find((capability) => capability.level === "dry-run"),
    ).toMatchObject({
      status: "unsupported",
      requiresOfficialProviderSemantics: true,
    });
    expect(
      capabilities.levels.find((capability) => capability.level === "trusted"),
    ).toMatchObject({ status: "unsupported" });
  });

  it("requires fresh evidence and an explicit verified owner decision before promotion", async () => {
    const fixture = trustFixture("promotion");
    const owner = fixture.owners.issue({
      id: "owner",
      principalId: "owner-principal",
    });
    const evidence = promotionEvidence();

    await expect(
      fixture.ladder.promote({
        target: target(),
        level: "shadow",
        policy: policy(),
        evidence,
        ownerIdentity: { ...owner },
      }),
    ).rejects.toThrow("not authenticated");
    await expect(
      fixture.ladder.promote({
        target: target(),
        level: "shadow",
        policy: policy(),
        evidence: { ...evidence, runCount: 1 },
        ownerIdentity: owner,
      }),
    ).rejects.toThrow("too few runs");
    await expect(
      fixture.ladder.promote({
        target: target(),
        level: "shadow",
        policy: policy(),
        evidence: {
          ...evidence,
          evals: [{ ...evidence.evals[0]!, status: "failed" }],
        },
        ownerIdentity: owner,
      }),
    ).rejects.toThrow("requires passing eval");

    const promoted = await fixture.ladder.promote({
      target: target(),
      level: "shadow",
      policy: policy(),
      evidence,
      ownerIdentity: owner,
    });
    expect(promoted.level).toBe("shadow");
    await expect(
      fixture.ladder.promote({
        target: target(),
        level: "dry-run",
        policy: policy(),
        evidence,
        ownerIdentity: owner,
      }),
    ).rejects.toThrow("dry-run is unsupported");
    await expect(
      fixture.ladder.promote({
        target: target(),
        level: "trusted",
        policy: policy(),
        evidence,
        ownerIdentity: owner,
      }),
    ).rejects.toThrow("trusted is unsupported");
    expect(
      (await fixture.ladder.readStateForTesting()).audit.at(-1),
    ).toMatchObject({
      event: "trust.promoted",
      fromLevel: "simulate",
      toLevel: "shadow",
    });
  });

  it("compares shadow input hashes without a synthetic-world mutation", async () => {
    const fixture = trustFixture("shadow");
    const owner = fixture.owners.issue({
      id: "owner",
      principalId: "owner-principal",
    });
    await fixture.ladder.promote({
      target: target(),
      level: "shadow",
      policy: policy(),
      evidence: promotionEvidence(),
      ownerIdentity: owner,
    });

    const matched = await fixture.ladder.compareShadow({
      prediction: observation(CONTEXT_HASH),
      actual: observation(CONTEXT_HASH),
    });
    const mismatched = await fixture.ladder.compareShadow({
      prediction: observation(CONTEXT_HASH),
      actual: observation("e".repeat(64)),
    });

    expect(matched).toMatchObject({
      level: "shadow",
      matched: true,
      target: target(),
    });
    expect(mismatched).toMatchObject({ level: "shadow", matched: false });
    expect((await fixture.ladder.inspect(target())).canary).toEqual({
      observed: 0,
      violations: 0,
      errors: 0,
    });
  });

  it("uses deterministic bounded canary assignment and compares predicted versus actual outcomes", async () => {
    const fixture = trustFixture("canary");
    const owner = fixture.owners.issue({
      id: "owner",
      principalId: "owner-principal",
    });
    const canaryPolicy = policy({
      canary: {
        tenantIds: ["tenant-a"],
        resourceIds: ["world-a"],
        percentageBps: 10_000,
      },
    });
    await promoteToBoundedAuto(fixture, owner, canaryPolicy);

    const first = await fixture.ladder.assignCanary(target(), canaryPolicy);
    const second = await fixture.ladder.assignCanary(target(), canaryPolicy);
    const outOfScope = await fixture.ladder.assignCanary(
      { ...target(), resourceId: "world-b" },
      canaryPolicy,
    );
    const matched = await fixture.ladder.compareBoundedOutcome({
      prediction: outcome(OUTCOME_HASH),
      actual: outcome(OUTCOME_HASH),
    });
    const mismatched = await fixture.ladder.compareBoundedOutcome({
      prediction: outcome(OUTCOME_HASH),
      actual: outcome("f".repeat(64)),
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({ assigned: true, bucket: expect.any(Number) });
    expect(first.bucket).toBeLessThan(10_000);
    expect(outOfScope).toMatchObject({
      assigned: false,
      reason: "resource is outside the configured canary scope",
    });
    expect(matched).toMatchObject({ level: "bounded-auto", matched: true });
    expect(mismatched).toMatchObject({ level: "bounded-auto", matched: false });
  });

  it("automatically demotes on policy violation, records rollback reasons, and stops a breached canary", async () => {
    const fixture = trustFixture("response");
    const owner = fixture.owners.issue({
      id: "owner",
      principalId: "owner-principal",
    });
    const demotePolicy = policy({
      canary: {
        tenantIds: ["tenant-a"],
        resourceIds: ["world-a"],
        percentageBps: 10_000,
      },
      stopConditions: { maxViolations: 2, maxErrors: 2 },
    });
    await promoteToBoundedAuto(fixture, owner, demotePolicy);
    const demoted = await fixture.ladder.recordCanaryOutcome({
      target: target(),
      policy: demotePolicy,
      outcome: "violation",
      reason: "policy-denied",
    });
    expect(demoted).toMatchObject({
      level: "approve",
      circuitBreaker: "closed",
      canary: { observed: 1, violations: 1, errors: 0 },
    });
    const rolledBack = await fixture.ladder.rollbackToApproval({
      target: target(),
      policy: demotePolicy,
      ownerIdentity: owner,
      reason: "operator-review",
    });
    expect(rolledBack.level).toBe("approve");

    const zeroStopFixture = trustFixture("zero-stop");
    const zeroStopOwner = zeroStopFixture.owners.issue({
      id: "owner",
      principalId: "owner-principal",
    });
    const zeroStopPolicy = policy({
      canary: {
        tenantIds: ["tenant-a"],
        resourceIds: ["world-a"],
        percentageBps: 10_000,
      },
      stopConditions: { maxViolations: 0, maxErrors: 0 },
    });
    await promoteToBoundedAuto(zeroStopFixture, zeroStopOwner, zeroStopPolicy);
    expect(
      (
        await zeroStopFixture.ladder.recordCanaryOutcome({
          target: target(),
          policy: zeroStopPolicy,
          outcome: "success",
          reason: "within-policy",
        })
      ).circuitBreaker,
    ).toBe("closed");
    expect(
      (
        await zeroStopFixture.ladder.recordCanaryOutcome({
          target: target(),
          policy: zeroStopPolicy,
          outcome: "error",
          reason: "provider-error",
        })
      ).circuitBreaker,
    ).toBe("open");

    const breakerFixture = trustFixture("breaker");
    const breakerOwner = breakerFixture.owners.issue({
      id: "owner",
      principalId: "owner-principal",
    });
    const breakerPolicy = policy({
      canary: {
        tenantIds: ["tenant-a"],
        resourceIds: ["world-a"],
        percentageBps: 10_000,
      },
      violationResponse: "open_circuit_breaker",
    });
    await promoteToBoundedAuto(breakerFixture, breakerOwner, breakerPolicy);
    const broken = await breakerFixture.ladder.recordCanaryOutcome({
      target: target(),
      policy: breakerPolicy,
      outcome: "violation",
      reason: "policy-denied",
    });
    expect(broken.circuitBreaker).toBe("open");
    await expect(
      breakerFixture.ladder.assignCanary(target(), breakerPolicy),
    ).rejects.toThrow("circuit breaker is open");
    await expect(
      breakerFixture.ladder.recordCanaryOutcome({
        target: target(),
        policy: breakerPolicy,
        outcome: "success",
        reason: "must-not-continue",
      }),
    ).rejects.toThrow("circuit breaker is open");
  });

  it("rejects production identity mixing, stale evidence, and tampered local audit state", async () => {
    const fixture = trustFixture("security");
    const owner = fixture.owners.issue({
      id: "owner",
      principalId: "owner-principal",
    });
    await expect(
      fixture.ladder.inspect({ ...target(), environment: "production" }),
    ).rejects.toThrow("synthetic identities only");
    await expect(
      fixture.ladder.promote({
        target: target(),
        level: "shadow",
        policy: policy(),
        evidence: {
          ...promotionEvidence(),
          observedAt: "2026-07-01T12:00:00.000Z",
        },
        ownerIdentity: owner,
      }),
    ).rejects.toThrow("stale");
    await expect(
      fixture.ladder.promote({
        target: target(),
        level: "shadow",
        policy: policy(),
        evidence: {
          ...promotionEvidence(),
          observedAt: "2026-08-16T12:00:01.000Z",
        },
        ownerIdentity: owner,
      }),
    ).rejects.toThrow("future");

    await fixture.ladder.promote({
      target: target(),
      level: "shadow",
      policy: policy(),
      evidence: promotionEvidence(),
      ownerIdentity: owner,
    });
    const state = await fixture.ladder.readStateForTesting();
    state.audit[0]!.reason = "tampered";
    await writeFile(
      join(getDataPaths().root, "trust-ladder-security.json"),
      JSON.stringify(state),
      "utf8",
    );
    await expect(fixture.ladder.readStateForTesting()).rejects.toThrow(
      TrustLadderError,
    );
  });
});

function trustFixture(name: string) {
  const now = () => new Date("2026-08-16T12:00:00.000Z");
  const owners = createTestTrustOwnerVerifier();
  return {
    owners,
    ladder: createLocalTrustLadder({
      path: join(getDataPaths().root, `trust-ladder-${name}.json`),
      now,
      ownerVerifier: owners.verifier,
    }),
  };
}

async function promoteToBoundedAuto(
  fixture: ReturnType<typeof trustFixture>,
  owner: { id: string; principalId: string },
  promotionPolicy: ReturnType<typeof policy>,
) {
  const evidence = promotionEvidence();
  await fixture.ladder.promote({
    target: target(),
    level: "shadow",
    policy: promotionPolicy,
    evidence,
    ownerIdentity: owner,
  });
  await fixture.ladder.promote({
    target: target(),
    level: "approve",
    policy: promotionPolicy,
    evidence,
    ownerIdentity: owner,
  });
  await fixture.ladder.promote({
    target: target(),
    level: "bounded-auto",
    policy: promotionPolicy,
    evidence,
    ownerIdentity: owner,
  });
}

function target() {
  return {
    provider: "ghostapi-synthetic" as const,
    environment: "synthetic" as const,
    tenantId: "tenant-a",
    resourceId: "world-a",
  };
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "ghostapi.trust-promotion-policy",
    id: "trust-policy",
    ownerPrincipalId: "owner-principal",
    automaticPromotion: false,
    minimumRuns: 2,
    requiredEvalIds: ["eval-a"],
    maxViolationRateBps: 0,
    maxErrorRateBps: 0,
    evidenceFreshnessMs: 60_000,
    canary: { tenantIds: [], resourceIds: [], percentageBps: 10_000 },
    stopConditions: { maxViolations: 1, maxErrors: 1 },
    violationResponse: "demote_to_approve" as const,
    ...overrides,
  };
}

function promotionEvidence() {
  return {
    runCount: 2,
    violations: 0,
    errors: 0,
    evals: [
      {
        id: "eval-a",
        status: "passed" as const,
        completedAt: "2026-08-16T12:00:00.000Z",
      },
    ],
    observedAt: "2026-08-16T12:00:00.000Z",
  };
}

function observation(contextHash: string) {
  return {
    target: target(),
    actionHash: ACTION_HASH,
    operation: "synthetic.subscription_failure",
    contextHash,
  };
}

function outcome(outcomeHash: string) {
  return {
    target: target(),
    actionHash: ACTION_HASH,
    outcomeHash,
    executionReceiptHash: RECEIPT_HASH,
  };
}
