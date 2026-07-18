import { describe, expect, it } from "vitest";
import { buildGenericPromptContext, getSystemPrompt, getUserPrompt } from "../src/ai/prompts.js";
import { inferGenericService, inferResourceName, isLikelyCollectionPath, isLikelyResourceByIdPath } from "../src/ai/genericInference.js";

describe("generic service inference", () => {
  it("infers common service-like labels without provider adapters", () => {
    expect(inferGenericService("/admin/api/products.json")).toBe("generic:shopify-like");
    expect(inferGenericService("/gmail/v1/users/me/messages/send")).toBe("generic:gmail-like");
    expect(inferGenericService("/v1/pages")).toBe("generic:notion-like");
    expect(inferGenericService("/api/chat.postMessage")).toBe("generic:slack-like");
    expect(inferGenericService("/totally/custom/resources")).toBe("generic:rest-like");
  });

  it("infers resource names and endpoint shape hints", () => {
    expect(inferResourceName("/admin/api/products.json")).toBe("product");
    expect(inferResourceName("/rest/api/3/issue/PROJ-123")).toBe("issue");
    expect(isLikelyCollectionPath("GET", "/v1/products")).toBe(true);
    expect(isLikelyCollectionPath("POST", "/v1/products")).toBe(false);
    expect(isLikelyResourceByIdPath("/v1/products/prod_123")).toBe(true);
  });
});

describe("generic prompt construction", () => {
  it("adds generic fallback behavior rules to the system prompt", () => {
    const prompt = getSystemPrompt("generic");
    expect(prompt).toContain("generic fallback");
    expect(prompt).toContain("Preserve safe request body fields");
    expect(prompt).toContain("product_mock_xxx");
    expect(prompt).toContain("collection endpoint");
  });

  it("adds service label, resource, endpoint shape, and id format to the user prompt", () => {
    const prompt = getUserPrompt("POST", "/admin/api/products.json", {}, { title: "Desk" }, "generic");
    expect(prompt).toContain("Service label: generic:shopify-like");
    expect(prompt).toContain("Inferred resource: product");
    expect(prompt).toContain("Endpoint shape: mutation-or-action");
    expect(prompt).toContain("ID format: product_mock_<short_random_suffix>");
    expect(prompt).toContain('"title":"Desk"');
  });

  it("can build generic context directly", () => {
    expect(buildGenericPromptContext("GET", "/v1/messages/msg_123", {}, null)).toContain("Endpoint shape: resource-by-id");
  });
});
