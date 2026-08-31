import { describe, expect, it } from "vitest";
import {
  sanitizeHeaders,
  sanitizeResponseHeaders,
} from "../src/security/headerSanitizer.js";

describe("sanitizeHeaders", () => {
  it("sanitizes header secrets and keeps safe headers", () => {
    const stripeTestKey = ["sk", "test", "abc123"].join("_");

    expect(
      sanitizeHeaders({
        authorization: `Bearer ${stripeTestKey}`,
        "content-type": "application/json",
        "x-api-key": "secret",
        accept: ["application/json"],
      }),
    ).toEqual({
      authorization: "Bearer ***",
      "content-type": "application/json",
      "x-api-key": "***",
      accept: ["application/json"],
    });
  });
});

describe("sanitizeResponseHeaders", () => {
  it("allows safe mock metadata and blocks framing, cookies, hop-by-hop, and CRLF values", () => {
    expect(
      sanitizeResponseHeaders({
        "content-type": "application/json",
        "retry-after": "5",
        "x-request-id": "request-1",
        "set-cookie": "session=stolen",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        "content-length": "999",
        location: "https://safe.example/path\r\nX-Injected: yes",
        authorization: "secret",
        "x-accel-redirect": "/internal",
      }),
    ).toEqual({
      "content-type": "application/json",
      "retry-after": "5",
      "x-request-id": "request-1",
    });
  });

  it("allows only single-slash same-origin Location paths", () => {
    expect(
      sanitizeResponseHeaders({ location: "/account/complete?source=mock" }),
    ).toEqual({ location: "/account/complete?source=mock" });
    for (const location of [
      "//outside.example/path",
      "https://outside.example/path",
      "http://outside.example/path",
      "javascript:alert(1)",
      "data:text/plain,redirect",
      "/\\outside.example/path",
      "/safe\r\nX-Evil: yes",
    ]) {
      expect(sanitizeResponseHeaders({ location })).toEqual({});
    }
  });
});
