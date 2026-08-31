import { describe, expect, it, vi } from "vitest";
import { getSystemPrompt, getUserPrompt } from "../src/ai/prompts.js";
import { repairJson, extractJson } from "../src/ai/jsonRepair.js";
import { generateAiMock } from "../src/ai/aiGenerator.js";

describe("AI Text Prompts", () => {
  it("builds provider specific system prompts", () => {
    expect(getSystemPrompt("stripe")).toContain("Stripe API");
    expect(getSystemPrompt("twilio")).toContain("Twilio REST API");
    expect(getSystemPrompt("openai")).toContain("OpenAI API");
    expect(getSystemPrompt("generic")).toContain("Analyze the URL path");
  });

  it("builds user prompts with request data", () => {
    const prompt = getUserPrompt(
      "POST",
      "/customers",
      { limit: 10 },
      { email: "a@b.com" },
    );
    expect(prompt).toContain("POST");
    expect(prompt).toContain("/customers");
    expect(prompt).toContain('{"limit":10}');
    expect(prompt).toContain('{"email":"a@b.com"}');
  });
});

describe("external LLM generation", () => {
  it("fails with explicit provenance instead of silently substituting a local fallback", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network down"));
    const generated = await generateAiMock(
      {
        method: "POST",
        path: "/tasks",
        query: {},
        headers: {},
        body: { title: "test" },
        receivedAt: "",
      },
      "generic",
      {} as never,
      {
        host: "127.0.0.1",
        port: 8080,
        model: "gpt-4o-mini",
        allowExternalLlm: true,
        apiKey: "test-key",
      },
    );

    expect(generated).toMatchObject({
      status: 502,
      headers: { "x-ghostapi-generation-source": "external-llm-error" },
    });
    expect(JSON.stringify(generated)).not.toContain("task_mock_");
    fetchSpy.mockRestore();
  });
});

describe("JSON Repair", () => {
  it("extracts pure json", () => {
    expect(extractJson('{"a": 1}')).toBe('{"a": 1}');
  });

  it("extracts json from markdown blocks", () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
    expect(extractJson('```\n{"a": 1}\n```')).toBe('{"a": 1}');
    expect(extractJson('   ```json\n  {"a": 1}  \n```  ')).toBe('{"a": 1}');
  });

  it("repairs trailing commas", () => {
    expect(repairJson('{"a": 1,}')).toEqual({ a: 1 });
    expect(repairJson("[1, 2, ]")).toEqual([1, 2]);
  });

  it("returns parsed json if completely valid", () => {
    expect(repairJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("returns null for completely unrepairable garbage", () => {
    expect(repairJson("hello world")).toBeNull();
  });
});
