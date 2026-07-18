import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { clearApiBehaviorsForTests, findApiBehavior, getApiBehaviors, setApiBehavior } from "../src/behavior/behaviorStore.js";
import { normalizedRequestFixture } from "./fixtures/requests.js";

describe("behavior store", () => {
  afterEach(async () => {
    await clearApiBehaviorsForTests();
    await rm(".ghostapi", { recursive: true, force: true });
  });

  it("sets and resolves deterministic method/path behavior", async () => {
    await setApiBehavior({ method: "post", path: "tasks", status: 429, body: { error: "slow down" } });

    await expect(findApiBehavior(normalizedRequestFixture({ method: "POST", path: "/tasks" }))).resolves.toEqual({
      method: "POST",
      path: "/tasks",
      status: 429,
      body: { error: "slow down" }
    });
  });

  it("preserves concurrent writes", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => setApiBehavior({ method: "GET", path: `/items/${index}`, status: 200, body: { index } })));

    expect(Object.keys(await getApiBehaviors())).toHaveLength(12);
  });
});
