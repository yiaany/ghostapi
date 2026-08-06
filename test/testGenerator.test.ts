import { describe, expect, it } from "vitest";
import { generateVitestFromEvent } from "../src/tests/testGenerator.js";

describe("generated Vitest", () => {
  it("uses GHOSTAPI_BASE_URL instead of a fixed fetch endpoint", () => {
    const generated = generateVitestFromEvent({
      id: "evt_1",
      timestamp: "2026-08-05T00:00:00.000Z",
      provider: "generic",
      method: "POST",
      path: "/tasks",
      statusCode: 200,
      source: "fallback",
      durationMs: 1,
      request: { body: { title: "Test" } },
      response: { ok: true }
    });

    expect(generated.content).toContain("process.env.GHOSTAPI_BASE_URL");
    expect(generated.content).toContain("fetch(`${baseUrl}/tasks`");
    expect(generated.content).not.toContain("fetch(`http://127.0.0.1:8080/tasks`");
  });
});
