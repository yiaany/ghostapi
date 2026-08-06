import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server/createServer.js";
import { clearState } from "../src/state/stateStore.js";
import { clearCache } from "../src/cache/index.js";
import { closeServer } from "./serverTestUtils.js";

async function withServer<T>(test: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = await createServer({ host: "127.0.0.1", port: 8080, model: "gpt-4o-mini" });
  const server = app.listen(0);
  const address = server.address();

  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Expected TCP server address");
  }

  try {
    return await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

describe("proxy handler", () => {
  beforeEach(async () => {
    await clearState();
    await clearCache();
  });

  it("synchronizes state between POST, GET by id, and GET list", async () => {
    await withServer(async (baseUrl) => {
      // 1. Create
      const postResp = await fetch(`${baseUrl}/v1/customers`, { method: "POST", body: '{"email":"a@b.com"}' });
      const createdObj = await postResp.json();
      expect(createdObj.id).toMatch(/^cus_/);
      expect(createdObj.object).toBe("customer");

      // 2. Read by ID (Cache bypassed, hitting State)
      const getResp = await fetch(`${baseUrl}/v1/customers/${createdObj.id}`);
      const retrievedObj = await getResp.json();
      expect(getResp.headers.get("x-ghostapi-state")).toBe("HIT");
      expect(retrievedObj.id).toBe(createdObj.id);

      // 3. Read list
      const listResp = await fetch(`${baseUrl}/v1/customers`);
      const listObj = await listResp.json();
      expect(listResp.headers.get("x-ghostapi-state")).toBe("HIT");
      expect(listObj.object).toBe("list");
      expect(listObj.data[0].id).toBe(createdObj.id);
    });
  });

  it("returns cached response on repeated identical requests", async () => {
    await withServer(async (baseUrl) => {
      const resp1 = await fetch(`${baseUrl}/cache-test`, { method: "POST", body: '{"key":"value"}' });
      const body1 = await resp1.json();
      expect(resp1.headers.get("x-ghostapi-cache")).toBe("MISS");

      const resp2 = await fetch(`${baseUrl}/cache-test`, { method: "POST", body: '{"key":"value"}' });
      const body2 = await resp2.json();
      expect(resp2.headers.get("x-ghostapi-cache")).toBe("HIT");
      
      expect(body2.id).toBe(body1.id);
    });
  });

  it("returns a generic mock response for arbitrary POST requests", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/anything?limit=10`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer secret" },
        body: JSON.stringify({ name: "Ada" })
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ object: "anything", provider: "generic", method: "POST", path: "/anything", status: "ok", name: "Ada" });
      expect(body.id).toMatch(/^anything_mock_/);
    });
  });

  it("runs Stripe customer creation through the versioned pack", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/customers`, { method: "POST" });
      const body = await response.json();

      expect(response.headers.get("x-ghostapi-provider-pack")).toBe("stripe@1.1.0");
      expect(body).toMatchObject({ object: "customer", livemode: false });
    });
  });

  it("returns provider-shaped Stripe payment intent mocks without an LLM key", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/payment_intents`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer stripe_test_ghostapi" },
        body: JSON.stringify({ amount: 2400, currency: "usd", confirm: true })
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ object: "payment_intent", amount: 2400, currency: "usd", status: "succeeded", livemode: false });
      expect(body.id).toMatch(/^pi_/);
      expect(body.client_secret).toMatch(/^pi_.*_secret_ghostapi$/);
    });
  });

  it("runs Resend through its versioned pack and persists its state transition", async () => {
    await withServer(async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/emails`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ghostapi-api-version": "v1" },
        body: JSON.stringify({ from: "sender@example.com", to: "reader@example.com", subject: "Hello" })
      });
      const created = await createResponse.json();

      expect(createResponse.status).toBe(200);
      expect(createResponse.headers.get("x-ghostapi-provider-pack")).toBe("resend@1.0.0");
      expect(createResponse.headers.get("x-ghostapi-api-version")).toBe("v1");
      expect(created).toMatchObject({ provider: "resend", method: "POST", path: "/emails" });
      expect(created.id).toMatch(/^email_mock_/);

      const readResponse = await fetch(`${baseUrl}/emails/${created.id}`);
      expect(readResponse.headers.get("x-ghostapi-state")).toBe("HIT");
      await expect(readResponse.json()).resolves.toEqual(created);
    });
  });

  it("returns a provider-shaped error for an unsupported pack API version", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/emails`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ghostapi-api-version": "v2" },
        body: JSON.stringify({ from: "sender@example.com", to: "reader@example.com", subject: "Hello" })
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        statusCode: 400,
        name: "invalid_api_version",
        message: "Unsupported Resend API version: v2. Supported versions: v1."
      });
    });
  });

  it("bypasses response caching for stateful Stripe pack mutations", async () => {
    await withServer(async (baseUrl) => {
      const request = () => fetch(`${baseUrl}/v1/payment_intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: 2400, currency: "usd" })
      });
      const first = await request();
      const firstBody = await first.json();
      const second = await request();
      const secondBody = await second.json();

      expect(first.headers.get("x-ghostapi-cache")).toBe("BYPASS");
      expect(second.headers.get("x-ghostapi-cache")).toBe("BYPASS");
      expect(secondBody.id).not.toBe(firstBody.id);
      expect(secondBody.client_secret).toMatch(/^pi_.*_secret_ghostapi$/);
    });
  });

  it("returns diagnostic errors without exposing detected Stripe authorization", async () => {
    await withServer(async (baseUrl) => {
      const stripeTestKey = ["sk", "test", "abc123"].join("_");
      const response = await fetch(`${baseUrl}/anything`, { method: "POST", headers: { authorization: `Bearer ${stripeTestKey}` } });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error.code).toBe("resource_missing");
      expect(JSON.stringify(body)).not.toContain(stripeTestKey);
    });
  });

  it("keeps reserved routes out of the proxy", async () => {
    await withServer(async (baseUrl) => {
      const health = await fetch(`${baseUrl}/health`);
      const dashboard = await fetch(`${baseUrl}/dashboard`);
      const events = await fetch(`${baseUrl}/events`, { headers: { accept: "text/event-stream" } });

      expect(await health.json()).toEqual({ ok: true });
      expect(dashboard.headers.get("content-type")).toContain("text/html");
      expect(events.headers.get("content-type")).toContain("text/event-stream");
      events.body?.cancel();
    });
  });

  it("accepts supported proxy methods", async () => {
    await withServer(async (baseUrl) => {
      for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
        const response = await fetch(`${baseUrl}/method-${method.toLowerCase()}`, { method });

        if (method === "OPTIONS") {
          expect(response.status).toBe(204);
        } else {
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ method, status: "ok" });
        }
      }

      const head = await fetch(`${baseUrl}/method-head`, { method: "HEAD" });
      expect(head.status).toBe(200);
    });
  });

  it("handles event streams directly", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/stream`, { method: "POST", body: '{"stream":true}', headers: { "content-type": "application/json" } });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const text = await response.text();
      expect(text).toContain("[DONE]");
    });
  });

  it("handles binary data safely", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/upload`, { method: "POST", body: Buffer.from("test upload") });
      expect(response.status).toBe(200);
    });
  });
});
