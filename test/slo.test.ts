import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLocalSloController,
  createSloRecordIdentity,
  createTestSloOperatorAuthorizer,
  examplePilotSloTargets,
} from "../src/reliability/index.js";

describe("local SLO controller", () => {
  it("starts with no targets and requires operator authorization to configure or evaluate", async () => {
    const { authorizer, issue } = createTestSloOperatorAuthorizer();
    const operator = issue({
      id: "sre",
      principalId: "sre-one",
      permissions: ["slo.configure", "slo.inspect"],
    });
    const controller = createLocalSloController({
      path: sloPath("slo-empty.json"),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
      operatorAuthorizer: authorizer,
    });

    const inspected = await controller.inspect({ identity: operator });
    expect(inspected.targets).toEqual([]);
    expect(inspected.sampleCounts).toEqual({
      policy_decision: 0,
      approval_delivery: 0,
      execution_latency: 0,
      availability: 0,
      duplicate_prevention: 0,
      receipt_verification: 0,
    });

    await expect(controller.evaluate({ identity: {} })).rejects.toThrow(
      "not authenticated",
    );
    await expect(
      controller.recordSample({ metric: "availability", ok: true }, {}),
    ).rejects.toThrow("record capability");
  });

  it("evaluates availability against a configured target and reports a breach or a met status", async () => {
    const { authorizer, issue } = createTestSloOperatorAuthorizer();
    const operator = issue({
      id: "sre",
      principalId: "sre-one",
      permissions: ["slo.configure", "slo.inspect"],
    });
    const recordIdentity = createSloRecordIdentity();
    const controller = createLocalSloController({
      path: sloPath("slo-eval.json"),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
      operatorAuthorizer: authorizer,
    });
    await controller.configureTarget({
      identity: operator,
      target: {
        id: "availability.sre",
        metric: "availability",
        windowMs: 60 * 60 * 1000,
        minimumSamples: 10,
        targetBps: 9_000,
      },
    });

    const insufficient = await controller.evaluate({ identity: operator });
    expect(insufficient.evaluations[0]).toMatchObject({
      metric: "availability",
      status: "insufficient_data",
      sampleCount: 0,
    });

    const samples = Array.from({ length: 10 }, (_, index) => ({
      metric: "availability" as const,
      ok: index < 8,
      runId: "run-1",
      actionId: `action-${index}`,
      labels: { tenantId: "tenant-a" },
    }));
    await controller.recordSamples(samples, recordIdentity);
    const breached = await controller.evaluate({ identity: operator });
    expect(breached.evaluations[0]).toMatchObject({
      metric: "availability",
      status: "breached",
      sampleCount: 10,
      okCount: 8,
      okRateBps: 8_000,
      targetBps: 9_000,
    });

    const recovery = Array.from({ length: 10 }, (_, index) => ({
      metric: "availability" as const,
      ok: true,
      runId: "run-2",
      actionId: `action-${index + 10}`,
      labels: { tenantId: "tenant-a" },
    }));
    await controller.recordSamples(recovery, recordIdentity);
    const met = await controller.evaluate({ identity: operator });
    expect(met.evaluations[0]).toMatchObject({
      status: "met",
      sampleCount: 20,
      okCount: 18,
      okRateBps: 9_000,
      budgetRemainingBps: 0,
    });
  });

  it("derives latency SLO success from durationMs against latencyMaxMs and honors the ok flag", async () => {
    const { authorizer, issue } = createTestSloOperatorAuthorizer();
    const operator = issue({
      id: "sre",
      principalId: "sre-one",
      permissions: ["slo.configure", "slo.inspect"],
    });
    const recordIdentity = createSloRecordIdentity();
    const controller = createLocalSloController({
      path: sloPath("slo-latency.json"),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
      operatorAuthorizer: authorizer,
    });
    await controller.configureTarget({
      identity: operator,
      target: {
        id: "latency.sre",
        metric: "execution_latency",
        windowMs: 60 * 60 * 1000,
        minimumSamples: 3,
        targetBps: 6_600,
        latencyMaxMs: 5_000,
      },
    });

    await controller.recordSamples(
      [
        { metric: "execution_latency", ok: true, durationMs: 100 },
        { metric: "execution_latency", ok: true, durationMs: 200 },
        { metric: "execution_latency", ok: false, durationMs: 100 },
        { metric: "execution_latency", ok: true, durationMs: 10_000 },
      ],
      recordIdentity,
    );
    const report = await controller.evaluate({ identity: operator });
    expect(report.evaluations[0]).toMatchObject({
      status: "breached",
      sampleCount: 4,
      okCount: 2,
      okRateBps: 5_000,
      latencyMaxMs: 5_000,
    });
  });

  it("filters to the evaluation window and trims bounded samples", async () => {
    const { authorizer, issue } = createTestSloOperatorAuthorizer();
    const operator = issue({
      id: "sre",
      principalId: "sre-one",
      permissions: ["slo.configure", "slo.inspect"],
    });
    const recordIdentity = createSloRecordIdentity();
    let clock = new Date("2029-01-01T00:00:00.000Z");
    const controller = createLocalSloController({
      path: sloPath("slo-window.json"),
      now: () => clock,
      operatorAuthorizer: authorizer,
    });
    await controller.configureTarget({
      identity: operator,
      target: {
        id: "availability.window",
        metric: "availability",
        windowMs: 60 * 60 * 1000,
        minimumSamples: 1,
        targetBps: 10_000,
      },
    });
    await controller.recordSample(
      {
        metric: "availability",
        ok: false,
        runId: "old-run",
        actionId: "old-action",
        labels: { tenantId: "tenant-a" },
      },
      recordIdentity,
    );

    clock = new Date("2029-01-02T00:00:00.000Z");
    await controller.recordSample(
      {
        metric: "availability",
        ok: true,
        runId: "new-run",
        actionId: "new-action",
        labels: { tenantId: "tenant-a" },
      },
      recordIdentity,
    );
    const report = await controller.evaluate({ identity: operator });
    expect(report.evaluations[0]).toMatchObject({
      sampleCount: 1,
      okCount: 1,
      okRateBps: 10_000,
    });
  });

  it("caps samples per metric and validates pilot example targets", async () => {
    const { authorizer, issue } = createTestSloOperatorAuthorizer();
    const operator = issue({
      id: "sre",
      principalId: "sre-one",
      permissions: ["slo.configure", "slo.inspect"],
    });
    const recordIdentity = createSloRecordIdentity();
    const controller = createLocalSloController({
      path: sloPath("slo-cap.json"),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
      operatorAuthorizer: authorizer,
    });
    for (const target of examplePilotSloTargets()) {
      await controller.configureTarget({ identity: operator, target });
    }
    const examples = await controller.inspect({ identity: operator });
    expect(examples.targets).toHaveLength(6);

    const batch = Array.from({ length: 5_200 }, (_, index) => ({
      metric: "availability" as const,
      ok: true,
      runId: "soak-run",
      actionId: `soak-${index}`,
      labels: { tenantId: "tenant-a" },
    }));
    for (let offset = 0; offset < batch.length; offset += 1_000) {
      await controller.recordSamples(
        batch.slice(offset, offset + 1_000),
        recordIdentity,
      );
    }
    const capped = await controller.inspect({ identity: operator });
    expect(capped.sampleCounts.availability).toBe(5_000);
    await expect(
      controller.recordSamples(batch.slice(0, 1_001), recordIdentity),
    ).rejects.toThrow("too large");
    await expect(
      controller.recordSample(
        { metric: "bogus", ok: true } as never,
        recordIdentity,
      ),
    ).rejects.toThrow("metric");
  });
});

function sloPath(fileName: string): string {
  return join(process.env.GHOSTAPI_DATA_DIR!, fileName);
}
