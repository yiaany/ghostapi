import { rm } from "node:fs/promises";
import { getDataPaths } from "../src/config/dataPaths.js";
import { afterEach, describe, expect, it } from "vitest";
import { findApiBehavior } from "../src/behavior/behaviorStore.js";
import {
  exportScenario,
  importScenario,
  listScenarioPresets,
  replayScenario,
  saveEventsAsScenario,
  shareScenario,
} from "../src/scenarios/scenarioStore.js";
import { normalizedRequestFixture } from "./fixtures/requests.js";

describe("scenario presets", () => {
  afterEach(async () => {
    await rm(getDataPaths().scenarios, { recursive: true, force: true });
  });

  it("lists, exports, shares, and replays provider scenarios", async () => {
    expect(
      (await listScenarioPresets()).map((scenario) => scenario.id),
    ).toEqual(
      expect.arrayContaining([
        "stripe-customer-create",
        "stripe-payment-intent-fail",
        "resend-email-send",
        "github-issue-create",
      ]),
    );

    const exported = await exportScenario("stripe-payment-intent-fail");
    expect(exported.steps[0]).toMatchObject({
      method: "POST",
      path: "/v1/payment_intents",
      status: 402,
    });
    expect(
      (await shareScenario("stripe-payment-intent-fail")).shareText,
    ).toMatch(/^ghostapi:\/\/scenario\//);

    await replayScenario("stripe-payment-intent-fail");
    await expect(
      findApiBehavior(
        normalizedRequestFixture({
          method: "POST",
          path: "/v1/payment_intents",
        }),
      ),
    ).resolves.toMatchObject({ status: 402 });
  });

  it("imports custom scenarios and saves traffic as scenarios", async () => {
    await importScenario({
      title: "Custom Thing",
      steps: [
        { method: "GET", path: "/custom", status: 200, body: { ok: true } },
      ],
    });
    expect(
      (await listScenarioPresets()).map((scenario) => scenario.id),
    ).toContain("custom-thing");

    const saved = await saveEventsAsScenario(
      [
        {
          id: "evt_1",
          timestamp: new Date().toISOString(),
          provider: "generic",
          method: "POST",
          path: "/orders",
          statusCode: 201,
          source: "ai",
          durationMs: 1,
          request: {},
          response: { id: "ord_1" },
        },
      ],
      { title: "Orders flow" },
    );

    expect(saved).toMatchObject({
      id: "orders-flow",
      steps: [{ method: "POST", path: "/orders", status: 201 }],
    });
  });

  it("rejects oversized scenario persistence", async () => {
    await expect(
      importScenario({
        title: "Too large",
        steps: [
          {
            method: "GET",
            path: "/large",
            status: 200,
            body: { payload: "x".repeat(513 * 1024) },
          },
        ],
      }),
    ).rejects.toThrow("size limit");
  });

  it("enforces the aggregate count quota under concurrent writes", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 220 }, (_, index) =>
        importScenario({
          id: `count-${index}`,
          title: `Count ${index}`,
          steps: [
            { method: "GET", path: `/count/${index}`, status: 200, body: {} },
          ],
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(200);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(20);
  }, 60_000);

  it("enforces the aggregate byte quota under concurrent writes", async () => {
    const payload = "x".repeat(500 * 1024);
    const results = await Promise.allSettled(
      Array.from({ length: 48 }, (_, index) =>
        importScenario({
          id: `bytes-${index}`,
          title: `Bytes ${index}`,
          steps: [
            {
              method: "GET",
              path: `/bytes/${index}`,
              status: 200,
              body: { payload },
            },
          ],
        }),
      ),
    );
    expect(results.some((result) => result.status === "rejected")).toBe(true);
    const stored = (await listScenarioPresets()).filter((scenario) =>
      scenario.id.startsWith("bytes-"),
    );
    expect(stored.length).toBe(
      results.filter((result) => result.status === "fulfilled").length,
    );
  }, 60_000);
});
