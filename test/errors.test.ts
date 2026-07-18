import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server/createServer.js";
import { clearState } from "../src/state/stateStore.js";
import { clearCache } from "../src/cache/index.js";
import { createProviderError } from "../src/errors/providerErrors.js";

async function withServer<T>(test: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = await createServer({ host: "127.0.0.1", port: 8080, model: "gpt-4o-mini" });
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

describe("Self-Healing Errors", () => {
  beforeEach(async () => {
    await clearState();
    await clearCache();
  });

  it("returns Stripe invalid_request_error for missing parameter", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/charges`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: {
          type: "invalid_request_error",
          message: "Missing required param: amount.",
          code: "parameter_missing",
          param: "amount"
        }
      });
    });
  });

  it("returns Twilio exact error format for missing To", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/2010-04-01/Accounts/AC123/Messages.json`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "Body=Hello" });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({
        code: 21604,
        message: "A 'To' phone number is required.",
        more_info: "https://www.twilio.com/docs/errors/21604",
        status: 400
      });
    });
  });

  it("returns Resend validation error", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/emails`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "a@b.com", subject: "hello" }) });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({
        statusCode: 400,
        name: "validation_error",
        message: "Missing required field: to"
      });
    });
  });

  it("formats generic, GitHub, and Discord provider errors", () => {
    expect(createProviderError("generic", { status: 429, message: "Rate limited", code: "rate_limited" })).toEqual({
      error: { message: "Rate limited", status: 429 }
    });

    expect(createProviderError("github", { status: 404, message: "Not Found" })).toEqual({
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest"
    });

    expect(createProviderError("discord", { status: 400, message: "Bad request", code: 50035 })).toEqual({
      code: 50035,
      message: "Bad request"
    });
  });

  it("formats OpenAI provider errors", () => {
    expect(createProviderError("openai", { status: 400, message: "Missing required parameter: model", param: "model", code: "missing_required_parameter" })).toEqual({
      error: {
        message: "Missing required parameter: model",
        type: "invalid_request_error",
        param: "model",
        code: "missing_required_parameter"
      }
    });
  });
});
