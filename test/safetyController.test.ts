import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getDataPaths } from "../src/config/dataPaths.js";
import {
  SafetyControllerError,
  createLocalSafetyController,
  createTestSafetyEmergencyAuthorizer,
} from "../src/safety/index.js";

describe("local safety controller", () => {
  it("persists scoped kill switches and blocks a race immediately before commit", async () => {
    const fixture = safetyFixture("kill-race");
    const action = safetyAction("race");
    const lease = await fixture.controller.admit(action);
    let sideEffects = 0;

    await fixture.controller.stop({
      identity: fixture.stopOperator,
      scope: { kind: "workload", id: "worker-one" },
      reason: "operator emergency stop",
    });
    await expect(
      lease.commit(async () => {
        sideEffects += 1;
      }),
    ).rejects.toThrow("Kill switch is active");

    expect(sideEffects).toBe(0);
    expect((await fixture.controller.inspect()).switches).toMatchObject([
      { scope: { kind: "workload", id: "worker-one" }, enabled: true },
    ]);
  });

  it("enforces every supported kill-switch scope", async () => {
    const scopes = [
      { kind: "global" as const },
      { kind: "organization" as const, id: "org-one" },
      { kind: "project" as const, id: "project-one" },
      { kind: "environment" as const, id: "synthetic" },
      { kind: "agent" as const, id: "agent-one" },
      { kind: "workload" as const, id: "worker-one" },
      { kind: "provider" as const, id: "ghostapi-synthetic" },
      { kind: "operation" as const, id: "synthetic.subscription_failure" },
      { kind: "risk_class" as const, id: "write" },
    ];
    for (const [index, scope] of scopes.entries()) {
      const fixture = safetyFixture(`scope-${index}`);
      await fixture.controller.stop({
        identity: fixture.stopOperator,
        scope,
        reason: "scope containment test",
      });
      await expect(
        fixture.controller.admit(safetyAction(`scope-${index}`)),
      ).rejects.toThrow("Kill switch is active");
    }
  });

  it("serializes every budget category, concurrency, and velocity under parallel admission", async () => {
    const categories = [
      "monetaryAmountMinor",
      "requests",
      "messages",
      "mutations",
      "deletes",
      "tokenCost",
    ] as const;
    for (const [index, category] of categories.entries()) {
      const fixture = safetyFixture(`budget-${category}`);
      await fixture.controller.configureBudget({
        identity: fixture.configureOperator,
        budget: budget(`budget-${index}`, { [category]: 1 }),
      });
      const [first, second] = await Promise.allSettled([
        fixture.controller.admit(safetyAction(`category-${index}-one`)),
        fixture.controller.admit(safetyAction(`category-${index}-two`)),
      ]);
      expect(
        [first, second].filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        [first, second].filter((result) => result.status === "rejected")[0],
      ).toMatchObject({ reason: expect.any(SafetyControllerError) });
    }

    const fixture = safetyFixture("parallel-limits");
    await fixture.controller.configureBudget({
      identity: fixture.configureOperator,
      budget: budget("concurrency", { concurrency: 1, velocity: 1 }),
    });
    const [first, second] = await Promise.allSettled([
      fixture.controller.admit(safetyAction("parallel-one")),
      fixture.controller.admit(safetyAction("parallel-two")),
    ]);
    expect(
      [first, second].filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect((await fixture.controller.inspect()).ledger).toHaveLength(1);
  });

  it("does not charge idempotent replay, rejects collisions, and does not retry circuit-open actions", async () => {
    const fixture = safetyFixture("idempotency");
    await fixture.controller.configureBudget({
      identity: fixture.configureOperator,
      budget: budget("requests", { requests: 1 }),
    });
    const first = await fixture.controller.admit(safetyAction("same"));
    const replay = await fixture.controller.admit(safetyAction("same"));

    expect(first.replay).toBe(false);
    expect(replay.replay).toBe(true);
    await expect(
      fixture.controller.admit({
        ...safetyAction("collision"),
        idempotencyKey: "idem-same",
        actionHash: "f".repeat(64),
      }),
    ).rejects.toThrow("collides");

    await fixture.controller.configureCircuit({
      identity: fixture.configureOperator,
      circuit: circuit("failure-breaker", {
        minimumSamples: 1,
        maxFailureRateBps: 0,
      }),
    });
    await first.complete({
      success: false,
      latencyMs: 1,
      reason: "synthetic failure",
    });
    await expect(
      fixture.controller.admit(safetyAction("new-after-breaker")),
    ).rejects.toThrow("circuit breaker is open");
    expect((await fixture.controller.inspect()).ledger).toHaveLength(1);
  });

  it("opens circuits for policy violations, latency, and reconciliation mismatches without auto-retry", async () => {
    const cases = [
      {
        id: "policy",
        settings: { maxPolicyViolations: 0 },
        outcome: { success: true, policyViolation: true, latencyMs: 1 },
      },
      {
        id: "latency",
        settings: { maxLatencyMs: 0 },
        outcome: { success: true, latencyMs: 1 },
      },
      {
        id: "reconciliation",
        settings: { maxReconciliationMismatches: 0 },
        outcome: { success: true, reconciliationMismatch: true, latencyMs: 1 },
      },
    ];
    for (const entry of cases) {
      const fixture = safetyFixture(`circuit-${entry.id}`);
      await fixture.controller.configureCircuit({
        identity: fixture.configureOperator,
        circuit: circuit(entry.id, entry.settings),
      });
      const lease = await fixture.controller.admit(safetyAction(entry.id));
      await lease.complete(entry.outcome);
      await expect(
        fixture.controller.admit(safetyAction(`${entry.id}-retry`)),
      ).rejects.toThrow("circuit breaker is open");
    }
  });

  it("requires independent re-enable permission and records emergency actions in the audit chain", async () => {
    const fixture = safetyFixture("reenable");
    await fixture.controller.stop({
      identity: fixture.stopOperator,
      scope: { kind: "global" },
      reason: "incident containment",
    });
    await expect(
      fixture.controller.reenable({
        identity: fixture.stopOperator,
        scope: { kind: "global" },
        reason: "premature recovery",
      }),
    ).rejects.toThrow("lacks required permission");
    await fixture.controller.reenable({
      identity: fixture.reenableOperator,
      scope: { kind: "global" },
      reason: "reviewed recovery",
    });

    const state = await fixture.controller.inspect();
    expect(state.switches).toMatchObject([
      {
        scope: { kind: "global" },
        enabled: false,
        changedBy: "reenable-principal",
      },
    ]);
    expect(state.audit.map((record) => record.event)).toContain(
      "kill_switch.stopped",
    );
    expect(state.audit.map((record) => record.event)).toContain(
      "kill_switch.reenabled",
    );
  });

  it("applies bounded backpressure, dead-letters stopped work, and runs a non-destructive game day", async () => {
    const fixture = safetyFixture("queue-game-day");
    for (let index = 0; index < 100; index += 1)
      await fixture.controller.enqueue(safetyAction(`queue-${index}`));
    await expect(
      fixture.controller.enqueue(safetyAction("queue-overflow")),
    ).rejects.toThrow("queue is full");
    await fixture.controller.stop({
      identity: fixture.stopOperator,
      scope: { kind: "project", id: "project-one" },
      reason: "drain unsafe queue",
    });
    const stopped = await fixture.controller.inspect();
    expect(stopped.queue).toEqual([]);
    expect(stopped.deadLetters).toHaveLength(100);

    await fixture.controller.reenable({
      identity: fixture.reenableOperator,
      scope: { kind: "project", id: "project-one" },
      reason: "queue review complete",
    });
    const gameDay = await fixture.controller.runScheduledGameDay({
      stopIdentity: fixture.stopOperator,
      reenableIdentity: fixture.reenableOperator,
      action: safetyAction("game-day"),
      reason: "scheduled local drill",
    });
    expect(gameDay.passed).toBe(true);
    expect(
      (await fixture.controller.inspect()).audit.map((record) => record.event),
    ).toContain("game_day.passed");
  });

  it("fails closed without a verified operator or a bounded non-secret emergency reason", async () => {
    const fixture = safetyFixture("auth");
    await expect(
      fixture.controller.stop({
        identity: { id: "forged" },
        scope: { kind: "global" },
        reason: "attempt",
      }),
    ).rejects.toThrow("not authenticated");
    await expect(
      fixture.controller.stop({
        identity: fixture.stopOperator,
        scope: { kind: "global" },
        reason: " ",
      }),
    ).rejects.toThrow("reason is invalid");
    await expect(
      createLocalSafetyController().stop({
        identity: fixture.stopOperator,
        scope: { kind: "global" },
        reason: "unconfigured",
      }),
    ).rejects.toThrow("not configured");

    await fixture.controller.stop({
      identity: fixture.stopOperator,
      scope: { kind: "global" },
      reason: "audit integrity test",
    });
    const state = await fixture.controller.inspect();
    state.audit[0]!.reason = "tampered";
    await writeFile(fixture.path, JSON.stringify(state), "utf8");
    await expect(fixture.controller.inspect()).rejects.toThrow(
      "audit record hash is invalid",
    );
  });

  it("expires reserved leases after the lease TTL and reclaims the idempotency key", async () => {
    const emergency = createTestSafetyEmergencyAuthorizer();
    const path = join(getDataPaths().root, "safety-lease-ttl.json");
    let tick = new Date("2026-08-16T12:00:00.000Z");
    const controller = createLocalSafetyController({
      path,
      now: () => tick,
      emergencyAuthorizer: emergency.authorizer,
      leaseTtlMs: 5_000,
    });
    const configureOperator = emergency.issue({
      id: "configure",
      principalId: "configure-principal",
      permissions: ["safety.configure"],
    });
    await controller.configureBudget({
      identity: configureOperator,
      budget: budget("requests", { requests: 1 }),
    });

    const first = await controller.admit(safetyAction("ttl-one"));
    expect(first.replay).toBe(false);
    tick = new Date("2026-08-16T12:00:06.000Z");
    const second = await controller.admit(safetyAction("ttl-two"));
    expect(second.replay).toBe(false);
    await expect(first.commit(async () => {})).rejects.toThrow(/lease/);
    await second.commit(async () => {});
    await second.complete({ success: true, latencyMs: 1 });
    tick = new Date("2026-08-16T12:01:07.000Z");
    const reclaimed = await controller.admit(safetyAction("ttl-one"));
    expect(reclaimed.replay).toBe(false);
    const state = await controller.inspect();
    expect(state.ledger.map((entry) => entry.action.idempotencyKey)).toContain(
      "idem-ttl-one",
    );
    expect(state.audit.map((record) => record.event)).toContain(
      "action.completed",
    );
  });

  it("records a complete outcome in the audit chain even when the lease was pruned", async () => {
    const emergency = createTestSafetyEmergencyAuthorizer();
    const path = join(getDataPaths().root, "safety-complete-pruned.json");
    let tick = new Date("2026-08-16T12:00:00.000Z");
    const controller = createLocalSafetyController({
      path,
      now: () => tick,
      emergencyAuthorizer: emergency.authorizer,
      leaseTtlMs: 5_000,
    });
    const lease = await controller.admit(safetyAction("pruned"));
    tick = new Date("2026-08-16T12:00:06.000Z");
    await controller.admit(safetyAction("other"));
    await lease.complete({
      success: false,
      latencyMs: 0,
      reason: "synthetic failure",
    });
    expect(
      (await controller.inspect()).audit.map((record) => record.event),
    ).toContain("action.unknown");
  });

  it("evicts the oldest dead letter instead of failing a kill switch on a full dead-letter queue", async () => {
    const emergency = createTestSafetyEmergencyAuthorizer();
    const path = join(getDataPaths().root, "safety-dlq-full.json");
    const controller = createLocalSafetyController({
      path,
      now: () => new Date("2026-08-16T12:00:00.000Z"),
      emergencyAuthorizer: emergency.authorizer,
    });
    const stopOperator = emergency.issue({
      id: "stop-operator",
      principalId: "stop-principal",
      permissions: ["safety.stop"],
    });
    const deadLetters = Array.from({ length: 1_000 }, (_, index) => ({
      id: `dead-${index}`,
      action: safetyAction(`old-${index}`),
      queuedAt: "2026-08-16T11:59:00.000Z",
      reason: "seeded",
      deadLetteredAt: "2026-08-16T11:59:30.000Z",
    }));
    const seeded = {
      schemaVersion: 1,
      switches: [],
      budgets: [],
      circuits: [],
      ledger: [],
      queue: [
        {
          id: "queued-1",
          action: safetyAction("new"),
          queuedAt: "2026-08-16T11:59:40.000Z",
        },
      ],
      deadLetters,
      auditAnchor: hash("ghostapi.safety.audit.v1"),
      audit: [],
    };
    await writeFile(path, JSON.stringify(seeded), "utf8");
    await controller.stop({
      identity: stopOperator,
      scope: { kind: "global" },
      reason: "drain with a full dead-letter queue",
    });
    const evicted = await controller.inspect();
    expect(evicted.deadLetters).toHaveLength(1_000);
    expect(
      evicted.deadLetters.some(
        (item) => item.action.idempotencyKey === "idem-new",
      ),
    ).toBe(true);
    expect(
      evicted.deadLetters.some(
        (item) => item.action.idempotencyKey === "idem-old-0",
      ),
    ).toBe(false);
  });
});

function safetyFixture(name: string) {
  const emergency = createTestSafetyEmergencyAuthorizer();
  const path = join(getDataPaths().root, `safety-${name}.json`);
  const controller = createLocalSafetyController({
    path,
    now: () => new Date("2026-08-16T12:00:00.000Z"),
    emergencyAuthorizer: emergency.authorizer,
  });
  return {
    controller,
    path,
    stopOperator: emergency.issue({
      id: "stop-operator",
      principalId: "stop-principal",
      permissions: ["safety.stop"],
    }),
    reenableOperator: emergency.issue({
      id: "reenable-operator",
      principalId: "reenable-principal",
      permissions: ["safety.reenable"],
    }),
    configureOperator: emergency.issue({
      id: "configure-operator",
      principalId: "configure-principal",
      permissions: ["safety.configure"],
    }),
  };
}

function safetyAction(id: string) {
  return {
    organizationId: "org-one",
    projectId: "project-one",
    environment: "synthetic",
    actorId: "agent-one",
    workloadId: "worker-one",
    provider: "ghostapi-synthetic",
    operation: "synthetic.subscription_failure",
    riskClass: "write" as const,
    idempotencyKey: `idem-${id}`,
    actionHash: hash(id),
    costs: {
      monetaryAmountMinor: 1,
      requests: 1,
      messages: 1,
      mutations: 1,
      deletes: 1,
      tokenCost: 1,
    },
  };
}

function budget(id: string, limits: Record<string, number>) {
  return {
    id,
    scope: { kind: "global" as const },
    windowMs: 60_000,
    velocityWindowMs: 60_000,
    limits,
  };
}

function circuit(id: string, overrides: Record<string, number> = {}) {
  return {
    id,
    scope: { kind: "global" as const },
    windowMs: 60_000,
    minimumSamples: 1,
    maxFailureRateBps: 10_000,
    maxPolicyViolations: 10,
    maxLatencyMs: 1_000,
    maxReconciliationMismatches: 10,
    state: "closed" as const,
    ...overrides,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
