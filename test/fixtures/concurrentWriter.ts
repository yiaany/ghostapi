import { saveToStateStore } from "../../src/state/stateStore.js";
import { setApiBehavior } from "../../src/behavior/behaviorStore.js";

const [store, prefix, countText] = process.argv.slice(2);
const count = Number(countText);

if ((store !== "state" && store !== "behavior") || !prefix || !Number.isInteger(count) || count < 1) {
  throw new Error("Usage: concurrentWriter.ts state|behavior <prefix> <count>");
}

for (let index = 0; index < count; index += 1) {
  if (store === "state") {
    await saveToStateStore(`${prefix}:${index}`, { id: `${prefix}:${index}` });
  } else {
    await setApiBehavior({ method: "GET", path: `/${prefix}/${index}`, status: 200, body: { id: `${prefix}:${index}` } });
  }
}
