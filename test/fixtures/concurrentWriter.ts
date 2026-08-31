import { saveToStateStore } from "../../src/state/stateStore.js";
import { setApiBehavior } from "../../src/behavior/behaviorStore.js";
import { runSubscriptionFailureWorkflow } from "../../src/worlds/index.js";
import { importScenario } from "../../src/scenarios/scenarioStore.js";

const [store, prefix, countText] = process.argv.slice(2);
const count = Number(countText);

if (
  (store !== "state" &&
    store !== "behavior" &&
    store !== "world" &&
    store !== "scenario") ||
  !prefix ||
  !Number.isInteger(count) ||
  count < 1
) {
  throw new Error(
    "Usage: concurrentWriter.ts state|behavior|world|scenario <prefix> <count>",
  );
}

let successfulWrites = 0;
for (let index = 0; index < count; index += 1) {
  if (store === "state") {
    await saveToStateStore(`${prefix}:${index}`, { id: `${prefix}:${index}` });
  } else if (store === "behavior") {
    await setApiBehavior({
      method: "GET",
      path: `/${prefix}/${index}`,
      status: 200,
      body: { id: `${prefix}:${index}` },
    });
  } else if (store === "world") {
    await runSubscriptionFailureWorkflow(
      "concurrent-world",
      `${prefix}-${index}`,
    );
  } else {
    try {
      await importScenario({
        id: `${prefix}-${index}`,
        title: `${prefix} ${index}`,
        steps: [
          { method: "GET", path: `/${prefix}/${index}`, status: 200, body: {} },
        ],
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("quota was reached")
      )
        throw error;
      continue;
    }
  }
  successfulWrites += 1;
}

console.log(String(successfulWrites));
