import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { findApiBehavior } from "../src/behavior/behaviorStore.js";
import { exportScenario, importScenario, listScenarioPresets, replayScenario, saveEventsAsScenario, shareScenario } from "../src/scenarios/scenarioStore.js";
import { normalizedRequestFixture } from "./fixtures/requests.js";

describe("scenario presets", () => {
  afterEach(async () => {
    await rm(".ghostapi", { recursive: true, force: true });
  });

  it("lists, exports, shares, and replays provider scenarios", async () => {
    expect((await listScenarioPresets()).map((scenario) => scenario.id)).toEqual(expect.arrayContaining(["stripe-customer-create", "stripe-payment-intent-fail", "resend-email-send", "github-issue-create"]));

    const exported = await exportScenario("stripe-payment-intent-fail");
    expect(exported.steps[0]).toMatchObject({ method: "POST", path: "/v1/payment_intents", status: 402 });
    expect((await shareScenario("stripe-payment-intent-fail")).shareText).toMatch(/^ghostapi:\/\/scenario\//);

    await replayScenario("stripe-payment-intent-fail");
    await expect(findApiBehavior(normalizedRequestFixture({ method: "POST", path: "/v1/payment_intents" }))).resolves.toMatchObject({ status: 402 });
  });

  it("imports custom scenarios and saves traffic as scenarios", async () => {
    await importScenario({ title: "Custom Thing", steps: [{ method: "GET", path: "/custom", status: 200, body: { ok: true } }] });
    expect((await listScenarioPresets()).map((scenario) => scenario.id)).toContain("custom-thing");

    const saved = await saveEventsAsScenario([
      { id: "evt_1", timestamp: new Date().toISOString(), provider: "generic", method: "POST", path: "/orders", statusCode: 201, source: "ai", durationMs: 1, request: {}, response: { id: "ord_1" } }
    ], { title: "Orders flow" });

    expect(saved).toMatchObject({ id: "orders-flow", steps: [{ method: "POST", path: "/orders", status: 201 }] });
  });
});
