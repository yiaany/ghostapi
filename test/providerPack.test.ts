import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProviderRuntime,
  getProviderManifests,
  getProviderPack,
  runProviderPackConformance,
  type ProviderPack
} from "../src/providers/index.js";
import { resendPack } from "../src/providers/packs/resendPack.js";

const deterministicRuntime = createProviderRuntime({
  clock: { now: () => new Date("2026-08-06T12:00:00.000Z") },
  idGenerator: { create: (prefix) => `${prefix}_fixture` }
});

describe("ProviderPack", () => {
  it("runs the same conformance harness with deterministic capabilities", () => {
    expect(runProviderPackConformance(resendPack, deterministicRuntime)).toEqual({
      provider: "resend",
      apiVersion: "v1",
      fixtures: 1
    });
    expect(deterministicRuntime.requireCapability("clock").now().toISOString()).toBe("2026-08-06T12:00:00.000Z");
  });

  it("rejects unknown runtime capabilities explicitly", () => {
    expect(() => deterministicRuntime.requireCapability("network" as never)).toThrow("Unknown provider capability: network");
  });

  it("catches malformed provider responses", () => {
    const malformedPack: ProviderPack = {
      ...resendPack,
      handleDeterministic() {
        return { status: 200, headers: { "content-type": "application/json" }, body: {} };
      }
    };

    expect(() => runProviderPackConformance(malformedPack, deterministicRuntime)).toThrow(/response.*id/i);
  });

  it("catches invalid state transitions", () => {
    const invalidTransitionPack: ProviderPack = {
      ...resendPack,
      transitionState() {
        return { key: "resend:wrong", value: {} };
      }
    };

    expect(() => runProviderPackConformance(invalidTransitionPack, deterministicRuntime)).toThrow(/state transition.*key/i);
  });

  it("fails closed when a pack selects an undeclared API version", () => {
    const undeclaredVersionPack: ProviderPack = {
      ...resendPack,
      selectApiVersion() {
        return { version: "v2" };
      }
    };

    expect(() => runProviderPackConformance(undeclaredVersionPack, deterministicRuntime)).toThrow("selected undeclared API version: v2");
  });

  it("publishes a versioned capability manifest and keeps legacy providers available", () => {
    expect(getProviderPack("resend")).toBe(resendPack);
    expect(getProviderPack("stripe")).toBeNull();
    expect(getProviderManifests()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "resend", implementation: "pack", packVersion: "1.0.0", apiVersions: { default: "v1", supported: ["v1"] } }),
      expect.objectContaining({ name: "stripe", implementation: "legacy" }),
      expect.objectContaining({ name: "generic", implementation: "fallback" })
    ]));
  });

  it("keeps pack modules behind the no-ambient-secret and no-network boundary", async () => {
    const packsDir = join(process.cwd(), "src", "providers", "packs");
    const files = (await readdir(packsDir)).filter((file) => file.endsWith(".ts"));

    for (const file of files) {
      const source = await readFile(join(packsDir, file), "utf8");
      expect(source, file).not.toMatch(/node:(?:fs|http|https|net|tls|dns)|process\.env|globalThis\.fetch|\bfetch\s*\(/);
    }
  });
});
