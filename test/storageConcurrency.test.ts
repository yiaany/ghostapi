import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clearState, getStateStore } from "../src/state/stateStore.js";
import {
  clearApiBehaviorsForTests,
  getApiBehaviors,
} from "../src/behavior/behaviorStore.js";
import { rm } from "node:fs/promises";
import { getDataPaths } from "../src/config/dataPaths.js";
import {
  listScenarioPresets,
  MAX_CUSTOM_SCENARIOS,
} from "../src/scenarios/scenarioStore.js";

const workerPath = fileURLToPath(
  new URL("./fixtures/concurrentWriter.ts", import.meta.url),
);

describe("cross-process persisted mutations", () => {
  it("preserves concurrent state writes from separate processes", async () => {
    await clearState();
    await Promise.all([
      runWriter("state", "left", 20),
      runWriter("state", "right", 20),
    ]);

    const state = await getStateStore();
    expect(Object.keys(state)).toHaveLength(40);
    expect(state["left:19"]).toEqual({ id: "left:19" });
    expect(state["right:19"]).toEqual({ id: "right:19" });
  });

  it("preserves concurrent behavior writes from separate processes", async () => {
    await clearApiBehaviorsForTests();
    await Promise.all([
      runWriter("behavior", "left", 20),
      runWriter("behavior", "right", 20),
    ]);

    const behaviors = await getApiBehaviors();
    expect(Object.keys(behaviors)).toHaveLength(40);
    expect(behaviors["GET /left/19"]?.body).toEqual({ id: "left:19" });
    expect(behaviors["GET /right/19"]?.body).toEqual({ id: "right:19" });
  });

  it("enforces the scenario count boundary across separate processes", async () => {
    await rm(getDataPaths().scenarios, { recursive: true, force: true });
    const results = await Promise.all([
      runWriter("scenario", "one", 55),
      runWriter("scenario", "two", 55),
      runWriter("scenario", "three", 55),
      runWriter("scenario", "four", 55),
    ]);

    expect(results.reduce((total, count) => total + count, 0)).toBe(
      MAX_CUSTOM_SCENARIOS,
    );
    expect(
      (await listScenarioPresets()).filter((scenario) =>
        /^(?:one|two|three|four)-/.test(scenario.id),
      ),
    ).toHaveLength(MAX_CUSTOM_SCENARIOS);
  }, 60_000);
});

function runWriter(
  store: "state" | "behavior" | "scenario",
  prefix: string,
  count: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", workerPath, store, prefix, String(count)],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(Number(stdout.trim()))
        : reject(new Error(`Writer exited ${code}: ${stderr}`)),
    );
  });
}
