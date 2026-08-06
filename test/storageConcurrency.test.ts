import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clearState, getStateStore } from "../src/state/stateStore.js";
import { clearApiBehaviorsForTests, getApiBehaviors } from "../src/behavior/behaviorStore.js";

const workerPath = fileURLToPath(new URL("./fixtures/concurrentWriter.ts", import.meta.url));

describe("cross-process persisted mutations", () => {
  it("preserves concurrent state writes from separate processes", async () => {
    await clearState();
    await Promise.all([runWriter("state", "left", 20), runWriter("state", "right", 20)]);

    const state = await getStateStore();
    expect(Object.keys(state)).toHaveLength(40);
    expect(state["left:19"]).toEqual({ id: "left:19" });
    expect(state["right:19"]).toEqual({ id: "right:19" });
  });

  it("preserves concurrent behavior writes from separate processes", async () => {
    await clearApiBehaviorsForTests();
    await Promise.all([runWriter("behavior", "left", 20), runWriter("behavior", "right", 20)]);

    const behaviors = await getApiBehaviors();
    expect(Object.keys(behaviors)).toHaveLength(40);
    expect(behaviors["GET /left/19"]?.body).toEqual({ id: "left:19" });
    expect(behaviors["GET /right/19"]?.body).toEqual({ id: "right:19" });
  });
});

function runWriter(store: "state" | "behavior", prefix: string, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, store, prefix, String(count)], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Writer exited ${code}: ${stderr}`)));
  });
}
