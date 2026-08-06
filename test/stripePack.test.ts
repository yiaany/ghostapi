import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server/createServer.js";
import { clearCache } from "../src/cache/index.js";
import { clearEvents, getEventsHistory } from "../src/server/eventsStore.js";
import { clearState, getStateStore } from "../src/state/stateStore.js";
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

async function requestJson(baseUrl: string, path: string, init: RequestInit = {}): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json() as Record<string, unknown> };
}

describe("Stripe core provider pack", () => {
  beforeEach(async () => {
    await clearState();
    await clearCache();
    await clearEvents();
  });

  it("supports official SDK-style form requests, CRUD state, and cursor pagination", async () => {
    await withServer(async (baseUrl) => {
      const create = async (email: string) => requestJson(baseUrl, "/v1/customers", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "stripe-version": "2026-02-25.clover" },
        body: `email=${encodeURIComponent(email)}&metadata%5Bsource%5D=sdk`
      });
      const first = await create("one@example.com");
      const second = await create("two@example.com");

      expect(first.response.status).toBe(200);
      expect(first.response.headers.get("request-id")).toMatch(/^req_/);
      expect(first.body).toMatchObject({ object: "customer", email: "one@example.com", metadata: { source: "sdk" } });

      const firstId = String(first.body.id);
      const secondId = String(second.body.id);
      const read = await requestJson(baseUrl, `/v1/customers/${firstId}`);
      expect(read.response.headers.get("x-ghostapi-state")).toBe("HIT");
      expect(read.body.id).toBe(firstId);

      const update = await requestJson(baseUrl, `/v1/customers/${firstId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Updated" })
      });
      expect(update.body.name).toBe("Updated");

      const page = await requestJson(baseUrl, `/v1/customers?limit=1&starting_after=${secondId}`);
      expect(page.body).toMatchObject({ object: "list", data: [expect.objectContaining({ id: firstId })], has_more: false, url: "/v1/customers" });
    });
  });

  it("creates payment methods, payment intents, checkout sessions, and refunds from JSON", async () => {
    await withServer(async (baseUrl) => {
      const method = await requestJson(baseUrl, "/v1/payment_methods", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "card", card: { number: "4242424242424242", cvc: "123" } })
      });
      expect(method.body).toMatchObject({ object: "payment_method", type: "card", card: { last4: "4242" } });

      const intent = await requestJson(baseUrl, "/v1/payment_intents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: 2500, currency: "usd", payment_method: method.body.id, confirm: true })
      });
      expect(intent.body).toMatchObject({ object: "payment_intent", amount: 2500, status: "succeeded", amount_received: 2500 });
      const retrievedIntent = await requestJson(baseUrl, `/v1/payment_intents/${String(intent.body.id)}`);
      expect(retrievedIntent.body).toMatchObject({ id: intent.body.id, client_secret: intent.body.client_secret });

      const checkout = await requestJson(baseUrl, "/v1/checkout/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "payment", success_url: "https://example.test/success", cancel_url: "https://example.test/cancel", line_items: [{ price_data: { currency: "usd", unit_amount: 2500 }, quantity: 1 }] })
      });
      expect(checkout.body).toMatchObject({ object: "checkout.session", mode: "payment", amount_total: 2500, payment_status: "unpaid" });

      const refund = await requestJson(baseUrl, "/v1/refunds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payment_intent: intent.body.id })
      });
      expect(refund.body).toMatchObject({ object: "refund", amount: 2500, payment_intent: intent.body.id, status: "succeeded" });
    });
  });

  it("replays idempotent requests atomically without retaining the caller key", async () => {
    await withServer(async (baseUrl) => {
      const key = "very-sensitive-idempotency-key";
      const create = () => requestJson(baseUrl, "/v1/payment_intents", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ amount: 1000, currency: "usd" })
      });
      const [first, second] = await Promise.all([create(), create()]);
      expect([first.response.headers.get("x-ghostapi-idempotency"), second.response.headers.get("x-ghostapi-idempotency")]).toContain("REPLAY");
      expect(second.body).toEqual(first.body);

      const collision = await requestJson(baseUrl, "/v1/payment_intents", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ amount: 1001, currency: "usd" })
      });
      expect(collision.response.status).toBe(400);
      expect(collision.body).toMatchObject({ error: { type: "idempotency_error", code: "idempotency_key_in_use" } });

      expect(JSON.stringify(await getStateStore())).not.toContain(key);
      expect(JSON.stringify(getEventsHistory())).not.toContain(key);
    });
  });

  it("fails closed for unsupported versions and endpoints, malformed values, missing resources, and decline scenarios", async () => {
    await withServer(async (baseUrl) => {
      const unsupportedVersion = await requestJson(baseUrl, "/v1/customers", { method: "POST", headers: { "content-type": "application/json", "stripe-version": "2025-01-01" }, body: JSON.stringify({ email: "ada@example.com" }) });
      expect(unsupportedVersion.response.status).toBe(400);
      expect(unsupportedVersion.response.headers.get("request-id")).toMatch(/^req_/);
      expect(unsupportedVersion.body).toMatchObject({ error: { code: "invalid_api_version", param: "Stripe-Version" } });

      const invalid = await requestJson(baseUrl, "/v1/payment_intents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: "wrong", currency: "usd" }) });
      expect(invalid.response.status).toBe(400);
      expect(invalid.body).toMatchObject({ error: { code: "parameter_invalid_integer", param: "amount" } });

      const decline = await requestJson(baseUrl, "/v1/payment_intents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 1000, currency: "usd", payment_method: "pm_card_chargeDeclined", confirm: true }) });
      expect(decline.response.status).toBe(402);
      expect(decline.body).toMatchObject({ error: { type: "card_error", code: "card_declined" } });

      const missing = await requestJson(baseUrl, "/v1/customers/cus_missing");
      expect(missing.response.status).toBe(404);
      expect(missing.body).toMatchObject({ error: { code: "resource_missing", param: "id" } });

      const endpoint = await requestJson(baseUrl, "/v1/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(endpoint.response.status).toBe(404);
      expect(endpoint.body).toMatchObject({ error: { code: "resource_missing" } });
    });
  });

  it("never persists or emits submitted payment card data", async () => {
    await withServer(async (baseUrl) => {
      const pan = "4242424242424242";
      const cvc = "123";
      await requestJson(baseUrl, "/v1/payment_methods", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "card", card: { number: pan, cvc } })
      });

      expect(JSON.stringify(await getStateStore())).not.toContain(pan);
      expect(JSON.stringify(await getStateStore())).not.toContain(cvc);
      expect(JSON.stringify(getEventsHistory())).not.toContain(pan);
      expect(JSON.stringify(getEventsHistory())).not.toContain(cvc);
    });
  });
});
