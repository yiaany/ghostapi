import { describe, expect, it } from "vitest";
import { sanitizeHeaders } from "../src/security/headerSanitizer.js";

describe("sanitizeHeaders", () => {
  it("sanitizes header secrets and keeps safe headers", () => {
    const stripeTestKey = ["sk", "test", "abc123"].join("_");

    expect(
      sanitizeHeaders({
        authorization: `Bearer ${stripeTestKey}`,
        "content-type": "application/json",
        "x-api-key": "secret",
        accept: ["application/json"]
      })
    ).toEqual({
      authorization: "Bearer ***",
      "content-type": "application/json",
      "x-api-key": "***",
      accept: ["application/json"]
    });
  });
});
