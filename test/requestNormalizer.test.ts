import { describe, expect, it } from "vitest";
import { normalizeRequest } from "../src/proxy/requestNormalizer.js";

describe("normalizeRequest", () => {
  it("returns method, path, query, sanitized headers, body, and receivedAt without unsafe rawBody", () => {
    const stripeTestKey = ["sk", "test", "abc123"].join("_");

    const request = {
      method: "POST",
      path: "/anything",
      query: { limit: "10", api_key: "query-secret" },
      headers: {
        authorization: "Bearer real-token",
        "content-type": "application/json",
        "x-api-key": "secret-key",
        cookie: "ghostapi_dashboard_token=random-cookie-secret",
      },
      body: { name: "Ada", token: stripeTestKey },
      rawBody: '{"name":"Ada"}',
    };

    const normalized = normalizeRequest(request as never);

    expect(normalized.method).toBe("POST");
    expect(normalized.path).toBe("/anything");
    expect(normalized.query).toEqual({ limit: "10", api_key: "***" });
    expect(normalized.headers).toMatchObject({
      authorization: "Bearer ***",
      "content-type": "application/json",
      "x-api-key": "***",
      cookie: "***",
    });
    expect(normalized.body).toEqual({ name: "Ada", token: "***" });
    expect(normalized).not.toHaveProperty("rawBody");
    expect(Date.parse(normalized.receivedAt)).not.toBeNaN();
  });

  it("redacts known secret patterns embedded in URL paths", () => {
    const secret = ["sk", "live", "path-secret"].join("_");
    const normalized = normalizeRequest({
      method: "GET",
      path: `/files/${secret}`,
      query: {},
      headers: {},
      body: undefined,
    } as never);

    expect(normalized.path).toBe("/files/***");
  });

  it("handles binary buffer bodies gracefully", () => {
    const normalized = normalizeRequest({
      method: "POST",
      path: "/upload",
      query: {},
      headers: {},
      body: Buffer.from("hello"),
    } as never);
    expect(normalized.body).toBe("[Binary Data: 5 bytes]");
  });
});
