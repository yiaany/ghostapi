import { rm } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server/createServer.js";
import { clearCache } from "../src/cache/index.js";
import { clearEvents, getEventsHistory } from "../src/server/eventsStore.js";
import { clearState } from "../src/state/stateStore.js";
import { resetFaultLabForTests } from "../src/fault/faultLab.js";
import { clearApiBehaviorsForTests, setApiBehavior } from "../src/behavior/behaviorStore.js";
import type { ServerConfig } from "../src/config/serverConfig.js";
import { genericTaskBody, stripeCustomerCreateBody } from "./fixtures/requests.js";

const baseConfig = { host: "127.0.0.1", port: 8080, model: "gpt-4o-mini" } satisfies ServerConfig;

async function withServer<T>(config: ServerConfig, test: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = await createServer(config);
  const server = app.listen(0);
  const address = server.address();

  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Expected TCP server address");
  }

  try {
    return await test(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

describe("proxy flow integration", () => {
  beforeEach(async () => {
    await clearState();
    await clearCache();
    await clearEvents();
    resetFaultLabForTests();
    await clearApiBehaviorsForTests();
  });

  afterAll(async () => {
    await rm(".ghostapi", { recursive: true, force: true });
  });

  it("serves state hits before cache or AI", async () => {
    await withServer(baseConfig, async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/v1/customers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stripeCustomerCreateBody)
      });
      const created = await createResponse.json();

      const readResponse = await fetch(`${baseUrl}/v1/customers/${created.id}`);
      const readBody = await readResponse.json();

      expect(readResponse.headers.get("x-ghostapi-state")).toBe("HIT");
      expect(readBody.id).toBe(created.id);
      expect(getEventsHistory().at(-1)).toMatchObject({ source: "state", statusCode: 200, path: `/v1/customers/${created.id}` });
    });
  });

  it("serves cache hits for repeated equivalent requests", async () => {
    await withServer(baseConfig, async (baseUrl) => {
      const first = await fetch(`${baseUrl}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(genericTaskBody) });
      const second = await fetch(`${baseUrl}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(genericTaskBody) });

      expect(first.headers.get("x-ghostapi-cache")).toBe("MISS");
      expect(second.headers.get("x-ghostapi-cache")).toBe("HIT");
      expect(getEventsHistory().at(-1)).toMatchObject({ source: "cache", path: "/tasks" });
    });
  });

  it("short-circuits provider validation errors", async () => {
    await withServer(baseConfig, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/charges`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.param).toBe("amount");
      expect(getEventsHistory().at(-1)).toMatchObject({ source: "error", statusCode: 400, path: "/v1/charges" });
    });
  });

  it("falls back locally when AI is unavailable without external API calls", async () => {
    await withServer(baseConfig, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(genericTaskBody) });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ provider: "generic", object: "task", title: genericTaskBody.title });
      expect(getEventsHistory().at(-1)).toMatchObject({ source: "ai", provider: "generic:rest-like" });
    });
  });

  it("uses explicit offline fallback without requiring an API key", async () => {
    await withServer({ ...baseConfig, offline: true }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(genericTaskBody) });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toMatch(/^task_mock_/);
      expect(body.priority).toBe("high");
    });
  });

  it("formats dashboard events with sanitized request and response details", async () => {
    await withServer(baseConfig, async (baseUrl) => {
      await fetch(`${baseUrl}/admin/api/products.json`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "secret_header_value" },
        body: JSON.stringify({ title: "Desk", api_key: "secret" })
      });

      const eventsResponse = await fetch(`${baseUrl}/api/events`);
      const events = await eventsResponse.json() as Array<Record<string, unknown>>;
      const event = events.at(-1) as Record<string, unknown>;

      expect(event).toMatchObject({ provider: "generic:shopify-like", method: "POST", path: "/admin/api/products.json", statusCode: 200 });
      expect(JSON.stringify(event)).not.toContain("secret_header_value");
      expect(JSON.stringify(event)).not.toContain('"api_key":"secret"');
      expect(event).toHaveProperty("durationMs");
      expect(event).toHaveProperty("request");
      expect(event).toHaveProperty("response");
    });
  });

  it("injects Fault Lab provider errors before normal proxy flow", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValueOnce(0.1).mockReturnValueOnce(0.1);
    await withServer(baseConfig, async (baseUrl) => {
      const configResponse = await fetch(`${baseUrl}/api/fault-lab`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, latencyMs: 0, errorRate: 100, statusCode: 429, retryAfterSeconds: 5 })
      });

      expect(await configResponse.json()).toMatchObject({ enabled: true, errorRate: 100, statusCode: 429 });

      const response = await fetch(`${baseUrl}/v1/customers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stripeCustomerCreateBody)
      });
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(response.headers.get("x-ghostapi-fault-lab")).toBe("error");
      expect(response.headers.get("retry-after")).toBe("5");
      expect(body.error.type).toBe("rate_limit_error");
      expect(getEventsHistory().at(-1)).toMatchObject({ source: "fault", statusCode: 429, provider: "stripe" });
    });
    randomSpy.mockRestore();
  });

  it("serves MCP-configured API behavior before cache and AI", async () => {
    await setApiBehavior({ method: "POST", path: "/tasks", status: 429, body: { error: "agent configured" } });

    await withServer(baseConfig, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(genericTaskBody) });
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(response.headers.get("x-ghostapi-behavior")).toBe("HIT");
      expect(body).toEqual({ error: "agent configured" });
      expect(getEventsHistory().at(-1)).toMatchObject({ source: "behavior", statusCode: 429, path: "/tasks" });
    });
  });
});
