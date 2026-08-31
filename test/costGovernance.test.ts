import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLocalCostGovernance,
  createTestCostOperatorAuthorizer,
} from "../src/reliability/index.js";

describe("local cost governance", () => {
  it("attributes costs, evaluates budgets, and raises acknowledgeable alerts", async () => {
    const { authorizer, issue } = createTestCostOperatorAuthorizer();
    const operator = issue({
      id: "finops",
      principalId: "finops-one",
      permissions: [
        "cost.record",
        "cost.configure",
        "cost.inspect",
        "cost.acknowledge",
      ],
    });
    const controller = createLocalCostGovernance({
      path: costPath("costs.json"),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
      operatorAuthorizer: authorizer,
    });

    const attribution = {
      agentId: "agent-one",
      projectId: "checkout-project",
      provider: "ghostapi-synthetic",
      actionClass: "subscription_failure",
      workflowId: "recovery-workflow",
    };
    await controller.recordCost({
      identity: operator,
      record: {
        tenantId: "tenant-a",
        runId: "run-1",
        actionId: "action-1",
        attribution,
        amounts: {
          monetaryAmountMinor: 1_250,
          requests: 10,
          messages: 20,
          mutations: 5,
          deletes: 0,
          tokenCost: 4_000,
        },
      },
    });
    await controller.recordCost({
      identity: operator,
      record: {
        tenantId: "tenant-a",
        runId: "run-2",
        actionId: "action-2",
        attribution,
        amounts: {
          monetaryAmountMinor: 2_750,
          requests: 30,
          messages: 40,
          mutations: 10,
          deletes: 1,
          tokenCost: 8_000,
        },
      },
    });

    await expect(
      controller.recordCost({
        identity: {},
        record: {
          tenantId: "tenant-a",
          runId: "run-3",
          actionId: "action-3",
          attribution,
          amounts: {
            monetaryAmountMinor: 0,
            requests: 1,
            messages: 0,
            mutations: 0,
            deletes: 0,
            tokenCost: 0,
          },
        },
      }),
    ).rejects.toThrow("not authenticated");

    await controller.configureBudget({
      identity: operator,
      budget: {
        id: "budget.requests",
        scope: { dimension: "project", value: "checkout-project" },
        windowMs: 24 * 60 * 60 * 1000,
        limits: { requests: 35 },
        alertOnExceed: true,
      },
    });
    await expect(
      controller.configureBudget({
        identity: operator,
        budget: {
          id: "budget.bad",
          scope: { dimension: "project", value: "checkout-project" },
          windowMs: 24 * 60 * 60 * 1000,
          limits: { requests: 1_000, tokenCost: 99_999 },
          alertOnExceed: true,
        },
      }),
    ).resolves.toBeTruthy();

    const report = await controller.report({ identity: operator });
    expect(report.totals).toEqual({
      monetaryAmountMinor: 4_000,
      requests: 40,
      messages: 60,
      mutations: 15,
      deletes: 1,
      tokenCost: 12_000,
    });
    expect(report.attribution).toContainEqual({
      dimension: "agent",
      value: "agent-one",
      totals: report.totals,
    });
    expect(report.attribution).toContainEqual({
      dimension: "provider",
      value: "ghostapi-synthetic",
      totals: report.totals,
    });
    expect(report.attribution).toContainEqual({
      dimension: "workflow",
      value: "recovery-workflow",
      totals: report.totals,
    });

    const budget = report.budgets.find(
      (candidate) => candidate.id === "budget.requests",
    )!;
    expect(budget.status).toBe("exceeded");
    expect(budget.exceeded).toEqual([
      { key: "requests", limit: 35, total: 40 },
    ]);
    expect(report.forecast).toMatchObject({
      method: "linear-extrapolation",
      approximation: true,
      sampleDays: 1,
      disclaimer: expect.stringContaining("not a provider invoice"),
    });

    const alerts = await controller.listAlerts({ identity: operator });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      budgetId: "budget.requests",
      status: "open",
      exceeded: [{ key: "requests", limit: 35, total: 40 }],
    });
    const acknowledged = await controller.acknowledgeAlert({
      identity: operator,
      alertId: alerts[0]!.id,
    });
    expect(acknowledged).toMatchObject({
      status: "acknowledged",
      acknowledgedBy: "finops-one",
    });
    await expect(
      controller.acknowledgeAlert({
        identity: operator,
        alertId: alerts[0]!.id,
      }),
    ).rejects.toThrow("already acknowledged");
  });

  it("removes budgets and reports within budgets as within", async () => {
    const { authorizer, issue } = createTestCostOperatorAuthorizer();
    const operator = issue({
      id: "finops",
      principalId: "finops-one",
      permissions: ["cost.record", "cost.configure", "cost.inspect"],
    });
    const controller = createLocalCostGovernance({
      path: costPath("costs-within.json"),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
      operatorAuthorizer: authorizer,
    });
    await controller.recordCost({
      identity: operator,
      record: {
        tenantId: "tenant-a",
        runId: "run-1",
        actionId: "action-1",
        attribution: {
          agentId: "agent-one",
          projectId: "checkout-project",
          provider: "ghostapi-synthetic",
          actionClass: "subscription_failure",
          workflowId: "recovery-workflow",
        },
        amounts: {
          monetaryAmountMinor: 100,
          requests: 5,
          messages: 5,
          mutations: 1,
          deletes: 0,
          tokenCost: 500,
        },
      },
    });

    await controller.configureBudget({
      identity: operator,
      budget: {
        id: "budget.requests",
        scope: { dimension: "project", value: "checkout-project" },
        windowMs: 24 * 60 * 60 * 1000,
        limits: { requests: 100 },
        alertOnExceed: false,
      },
    });
    const report = await controller.report({ identity: operator });
    expect(report.budgets[0]).toMatchObject({ status: "within" });

    await controller.removeBudget({
      identity: operator,
      budgetId: "budget.requests",
    });
    expect(
      (await controller.report({ identity: operator })).budgets,
    ).toHaveLength(0);
  });

  it("rejects duplicate cost records per tenant and action, and scopes reports and alerts by tenant", async () => {
    const { authorizer, issue } = createTestCostOperatorAuthorizer();
    const tenantA = issue({
      id: "finops-a",
      principalId: "finops-a-one",
      tenantId: "tenant-a",
      permissions: ["cost.record", "cost.configure", "cost.inspect"],
    });
    const tenantB = issue({
      id: "finops-b",
      principalId: "finops-b-one",
      tenantId: "tenant-b",
      permissions: ["cost.record", "cost.configure", "cost.inspect"],
    });
    const controller = createLocalCostGovernance({
      path: costPath("costs-tenants.json"),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
      operatorAuthorizer: authorizer,
    });

    const attribution = {
      agentId: "agent-one",
      projectId: "checkout-project",
      provider: "ghostapi-synthetic",
      actionClass: "subscription_failure",
      workflowId: "recovery-workflow",
    };
    await controller.recordCost({
      identity: tenantA,
      record: {
        tenantId: "tenant-a",
        runId: "run-1",
        actionId: "action-1",
        attribution,
        amounts: {
          monetaryAmountMinor: 1_000,
          requests: 10,
          messages: 0,
          mutations: 0,
          deletes: 0,
          tokenCost: 0,
        },
      },
    });
    await expect(
      controller.recordCost({
        identity: tenantA,
        record: {
          tenantId: "tenant-a",
          runId: "run-2",
          actionId: "action-1",
          attribution,
          amounts: {
            monetaryAmountMinor: 1_000,
            requests: 10,
            messages: 0,
            mutations: 0,
            deletes: 0,
            tokenCost: 0,
          },
        },
      }),
    ).rejects.toThrow("already exists");
    await controller.recordCost({
      identity: tenantB,
      record: {
        tenantId: "tenant-b",
        runId: "run-1",
        actionId: "action-1",
        attribution,
        amounts: {
          monetaryAmountMinor: 5_000,
          requests: 50,
          messages: 0,
          mutations: 0,
          deletes: 0,
          tokenCost: 0,
        },
      },
    });

    const reportA = await controller.report({ identity: tenantA });
    expect(reportA.tenantId).toBe("tenant-a");
    expect(reportA.totals.requests).toBe(10);
    const reportB = await controller.report({ identity: tenantB });
    expect(reportB.totals.requests).toBe(50);
  });

  it("keeps report pure and only persists alerts when alerts are listed", async () => {
    const { authorizer, issue } = createTestCostOperatorAuthorizer();
    const operator = issue({
      id: "finops",
      principalId: "finops-one",
      permissions: ["cost.record", "cost.configure", "cost.inspect"],
    });
    const controller = createLocalCostGovernance({
      path: costPath("costs-pure.json"),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
      operatorAuthorizer: authorizer,
    });
    const attribution = {
      agentId: "agent-one",
      projectId: "checkout-project",
      provider: "ghostapi-synthetic",
      actionClass: "subscription_failure",
      workflowId: "recovery-workflow",
    };
    await controller.recordCost({
      identity: operator,
      record: {
        tenantId: "tenant-a",
        runId: "run-1",
        actionId: "action-1",
        attribution,
        amounts: {
          monetaryAmountMinor: 0,
          requests: 50,
          messages: 0,
          mutations: 0,
          deletes: 0,
          tokenCost: 500,
        },
      },
    });
    await controller.configureBudget({
      identity: operator,
      budget: {
        id: "budget.requests",
        scope: { dimension: "project", value: "checkout-project" },
        windowMs: 24 * 60 * 60 * 1000,
        limits: { requests: 35 },
        alertOnExceed: true,
      },
    });
    await controller.configureBudget({
      identity: operator,
      budget: {
        id: "budget.silent",
        scope: { dimension: "project", value: "checkout-project" },
        windowMs: 24 * 60 * 60 * 1000,
        limits: { tokenCost: 1 },
        alertOnExceed: false,
      },
    });

    const report = await controller.report({ identity: operator });
    expect(report.alerts.length).toBeGreaterThan(0);
    expect(
      report.budgets.some(
        (budget) =>
          budget.id === "budget.silent" && budget.status === "exceeded",
      ),
    ).toBe(true);
    expect(
      (await controller.listAlerts({ identity: operator })).some(
        (alert) => alert.budgetId === "budget.silent",
      ),
    ).toBe(false);
  });
});

function costPath(fileName: string): string {
  return join(process.env.GHOSTAPI_DATA_DIR!, fileName);
}
