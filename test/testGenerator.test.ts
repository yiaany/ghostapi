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
      response: { ok: true },
    });

    expect(generated.content).toContain("process.env.GHOSTAPI_BASE_URL");
    expect(generated.content).toContain('const path = "/tasks"');
    expect(generated.content).toContain("fetch(new URL(path, baseUrl)");
    expect(generated.content).not.toContain(
      "fetch(`http://127.0.0.1:8080/tasks`",
    );
  });

  it("serializes attacker-controlled paths as inert string literals", () => {
    const generated = generateVitestFromEvent({
      id: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-08-05T00:00:00.000Z",
      provider: "generic",
      method: "GET",
      path: '/x`; throw new Error("injected"); //${process.env.SECRET}',
      statusCode: 200,
      source: "fallback",
      durationMs: 1,
      request: {},
      response: {},
    });

    expect(generated.content).toContain(
      'const path = "/x`; throw new Error(\\"injected\\"); //${process.env.SECRET}"',
    );
    expect(generated.content).not.toContain("${baseUrl}/x`");
  });
});
