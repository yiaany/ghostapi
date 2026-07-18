import { describe, expect, it } from "vitest";
import { normalizeRequest } from "../src/proxy/requestNormalizer.js";

describe("normalizeRequest", () => {
  it("returns method, path, query, sanitized headers, body, rawBody, and receivedAt", () => {
    const stripeTestKey = ["sk", "test", "abc123"].join("_");

    const request = {
      method: "POST",
      path: "/anything",
      query: { limit: "10", api_key: "query-secret" },
      headers: {
        authorization: "Bearer real-token",
        "content-type": "application/json",
        "x-api-key": "secret-key"
      },
      body: { name: "Ada", token: stripeTestKey },
      rawBody: '{"name":"Ada"}'
    };

    const normalized = normalizeRequest(request as never);

    expect(normalized.method).toBe("POST");
    expect(normalized.path).toBe("/anything");
    expect(normalized.query).toEqual({ limit: "10", api_key: "***" });
    expect(normalized.headers).toMatchObject({
      authorization: "Bearer ***",
      "content-type": "application/json",
      "x-api-key": "***"
    });
    expect(normalized.body).toEqual({ name: "Ada", token: "***" });
    expect(normalized.rawBody).toBe('{"name":"Ada"}');
    expect(Date.parse(normalized.receivedAt)).not.toBeNaN();
  });

  it("omits rawBody when it is not available", () => {
    const normalized = normalizeRequest({ method: "GET", path: "/items", query: {}, headers: {}, body: undefined } as never);

    expect(normalized).not.toHaveProperty("rawBody");
  });

  it("handles binary buffer bodies gracefully", () => {
    const normalized = normalizeRequest({ method: "POST", path: "/upload", query: {}, headers: {}, body: Buffer.from("hello") } as never);
    expect(normalized.body).toBe("[Binary Data: 5 bytes]");
  });
});
