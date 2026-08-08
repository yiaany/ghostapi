import { saveToStateStore } from "../../src/state/stateStore.js";
import { setApiBehavior } from "../../src/behavior/behaviorStore.js";
import { runSubscriptionFailureWorkflow } from "../../src/worlds/index.js";

const [store, prefix, countText] = process.argv.slice(2);
const count = Number(countText);

if ((store !== "state" && store !== "behavior" && store !== "world") || !prefix || !Number.isInteger(count) || count < 1) {
  throw new Error("Usage: concurrentWriter.ts state|behavior|world <prefix> <count>");
}

for (let index = 0; index < count; index += 1) {
  if (store === "state") {
    await saveToStateStore(`${prefix}:${index}`, { id: `${prefix}:${index}` });
  } else if (store === "behavior") {
    await setApiBehavior({ method: "GET", path: `/${prefix}/${index}`, status: 200, body: { id: `${prefix}:${index}` } });
  } else {
    await runSubscriptionFailureWorkflow("concurrent-world", `${prefix}-${index}`);
  }
}
