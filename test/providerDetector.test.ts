import { describe, expect, it } from "vitest";
import { detectProvider } from "../src/proxy/providerDetector.js";

describe("detectProvider", () => {
  const stripeTestKey = ["sk", "test", "abc123"].join("_");

  it("uses explicit provider header override", () => {
    expect(detectProvider("/anything", { "x-ghostapi-provider": "stripe" })).toBe("stripe");
  });

  it("uses explicit provider query override", () => {
    expect(detectProvider({ path: "/anything", query: { ghost_provider: "github" } })).toBe("github");
  });

  it("detects Stripe", () => {
    expect(detectProvider("/v1/customers")).toBe("stripe");
    expect(detectProvider("/anything", { "stripe-version": "2024-06-20" })).toBe("stripe");
    expect(detectProvider("/anything", { authorization: `Bearer ${stripeTestKey}` })).toBe("stripe");
  });

  it("detects Twilio", () => {
    expect(detectProvider("/2010-04-01/Accounts/AC123/Messages.json")).toBe("twilio");
    expect(detectProvider("/Accounts/AC123/Messages.json")).toBe("twilio");
  });

  it("detects Resend", () => {
    expect(detectProvider("/emails")).toBe("resend");
    expect(detectProvider("/emails/email_123")).toBe("resend");
  });

  it("detects GitHub", () => {
    expect(detectProvider("/repos/octo/hello-world")).toBe("github");
    expect(detectProvider("/user/repos")).toBe("github");
    expect(detectProvider("/anything", { "x-github-api-version": "2022-11-28" })).toBe("github");
  });

  it("detects Discord", () => {
    expect(detectProvider("/api/v10/channels/123/messages")).toBe("discord");
    expect(detectProvider("/channels/123/messages")).toBe("discord");
    expect(detectProvider("/webhooks/123/token")).toBe("discord");
    expect(detectProvider({ path: "/anything", query: { guild_id: "guild_123" } })).toBe("discord");
    expect(detectProvider({ path: "/anything", body: { nested: { channel_id: "channel_123" } } })).toBe("discord");
  });

  it("detects OpenAI", () => {
    expect(detectProvider("/v1/chat/completions")).toBe("openai");
    expect(detectProvider("/v1/responses")).toBe("openai");
    expect(detectProvider("/v1/embeddings")).toBe("openai");
    expect(detectProvider("/anything", { "openai-organization": "org_mock" })).toBe("openai");
  });

  it("falls back to generic", () => {
    expect(detectProvider("/unknown/resource")).toBe("generic");
    expect(detectProvider("/v1/pages")).toBe("generic");
    expect(detectProvider("/api/chat.postMessage")).toBe("generic");
  });
});
