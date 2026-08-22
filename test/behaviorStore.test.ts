import { afterEach, describe, expect, it } from "vitest";
import { clearApiBehaviorsForTests, findApiBehavior, getApiBehaviors, setApiBehavior } from "../src/behavior/behaviorStore.js";
import { normalizedRequestFixture } from "./fixtures/requests.js";

describe("behavior store", () => {
  afterEach(async () => {
    await clearApiBehaviorsForTests();
  });

  it("sets and resolves deterministic method/path behavior", async () => {
    await setApiBehavior({ method: "post", path: "tasks", status: 429, body: { error: "slow down" }, delayMs: 25 });

    await expect(findApiBehavior(normalizedRequestFixture({ method: "POST", path: "/tasks" }))).resolves.toEqual({
      method: "POST",
      path: "/tasks",
      status: 429,
      body: { error: "slow down" },
      delayMs: 25
    });
  });

  it("rejects an unsafe deterministic delay", async () => {
    await expect(setApiBehavior({ method: "GET", path: "/tasks", status: 200, body: {}, delayMs: 10_001 })).rejects.toThrow("delayMs");
  });

  it("rejects unsafe response headers", async () => {
    await expect(setApiBehavior({ method: "GET", path: "/tasks", status: 200, body: {}, headers: { "set-cookie": "session=stolen" } })).rejects.toThrow("unsafe or unsupported");
    await expect(setApiBehavior({ method: "GET", path: "/tasks", status: 200, body: {}, headers: { location: "https://safe.example\r\nX-Evil: yes" } })).rejects.toThrow("unsafe or unsupported");
  });

  it("preserves concurrent writes", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => setApiBehavior({ method: "GET", path: `/items/${index}`, status: 200, body: { index } })));

    expect(Object.keys(await getApiBehaviors())).toHaveLength(12);
  });
});
