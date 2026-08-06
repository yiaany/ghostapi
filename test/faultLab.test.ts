import { afterEach, describe, expect, it } from "vitest";
import { decideFault, getFaultLabConfig, resetFaultLabForTests, updateFaultLabConfig } from "../src/fault/faultLab.js";

describe("Fault Lab", () => {
  afterEach(async () => {
    await resetFaultLabForTests();
  });

  it("keeps a safe disabled default", async () => {
    await expect(getFaultLabConfig()).resolves.toMatchObject({ enabled: false, latencyMinMs: 2000, latencyMaxMs: 5000, errorRate: 15, statusCode: 429 });
    await expect(decideFault("stripe")).resolves.toEqual({ type: "off" });
  });

  it("returns provider-formatted 429 faults when Chaos Mode selects rate limiting", async () => {
    await updateFaultLabConfig({ enabled: true, latencyMs: 10, errorRate: 100, statusCode: 429, retryAfterSeconds: 3 });
    const randomValues = [0.1, 0.1];
    const decision = await decideFault("stripe", () => randomValues.shift() ?? 0);

    expect(decision).toMatchObject({ type: "error", latencyMs: 10, statusCode: 429, retryAfterSeconds: 3 });
    expect(decision.type === "error" ? decision.body : null).toEqual({
      error: {
        type: "rate_limit_error",
        message: "Chaos Mode simulated rate limit. Please retry later.",
        code: "rate_limit",
        param: "unknown"
      }
    });
  });

  it("returns provider-formatted configured 503 faults", async () => {
    await updateFaultLabConfig({ enabled: true, errorRate: 100, statusCode: 503 });
    const randomValues = [0.1, 0.5];
    const decision = await decideFault("twilio", () => randomValues.shift() ?? 0);

    expect(decision).toMatchObject({ type: "error", statusCode: 503 });
    expect(decision.type === "error" ? decision.body : null).toMatchObject({
      code: 503,
      message: "Chaos Mode simulated upstream 503 response."
    });
  });

  it("honors configured upstream status when Chaos Mode selects upstream failure", async () => {
    await updateFaultLabConfig({ enabled: true, errorRate: 100, statusCode: 502 });
    const randomValues = [0.1, 0.5];
    const decision = await decideFault("generic", () => randomValues.shift() ?? 0);

    expect(decision).toMatchObject({ type: "error", statusCode: 502 });
    expect(decision.type === "error" ? decision.body : null).toMatchObject({ error: { status: 502 } });
  });

  it("injects 2-5 second latency when Chaos Mode selects delay", async () => {
    await updateFaultLabConfig({ enabled: true, latencyMs: 0, latencyMinMs: 2000, latencyMaxMs: 5000, errorRate: 100 });
    const randomValues = [0.1, 0.9, 0.5];
    await expect(decideFault("generic", () => randomValues.shift() ?? 0)).resolves.toEqual({ type: "delay", latencyMs: 3500 });
  });

  it("does nothing for the other 85 percent of traffic", async () => {
    await updateFaultLabConfig({ enabled: true, errorRate: 15 });
    await expect(decideFault("generic", () => 0.2)).resolves.toEqual({ type: "off" });
  });

  it("validates config boundaries", async () => {
    await expect(updateFaultLabConfig({ errorRate: 101 })).rejects.toThrow("Expected integer between 0 and 100");
    await expect(updateFaultLabConfig({ latencyMs: -1 })).rejects.toThrow("Expected integer between 0 and 10000");
    await expect(updateFaultLabConfig({ latencyMinMs: 5000, latencyMaxMs: 2000 })).rejects.toThrow("latencyMaxMs");
    await expect(updateFaultLabConfig({ statusCode: 418 })).rejects.toThrow("statusCode must be one of");
  });

  it("persists partial updates without overwriting unrelated fields", async () => {
    await Promise.all([
      updateFaultLabConfig({ enabled: true }),
      updateFaultLabConfig({ errorRate: 77 })
    ]);

    await expect(getFaultLabConfig()).resolves.toMatchObject({ enabled: true, errorRate: 77 });
  });
});
