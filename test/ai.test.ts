import { describe, expect, it } from "vitest";
import { getSystemPrompt, getUserPrompt } from "../src/ai/prompts.js";
import { repairJson, extractJson } from "../src/ai/jsonRepair.js";

describe("AI Text Prompts", () => {
  it("builds provider specific system prompts", () => {
    expect(getSystemPrompt("stripe")).toContain("Stripe API");
    expect(getSystemPrompt("twilio")).toContain("Twilio REST API");
    expect(getSystemPrompt("openai")).toContain("OpenAI API");
    expect(getSystemPrompt("generic")).toContain("Analyze the URL path");
  });

  it("builds user prompts with request data", () => {
    const prompt = getUserPrompt("POST", "/customers", { limit: 10 }, { email: "a@b.com" });
    expect(prompt).toContain("POST");
    expect(prompt).toContain("/customers");
    expect(prompt).toContain('{"limit":10}');
    expect(prompt).toContain('{"email":"a@b.com"}');
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
    expect(repairJson('[1, 2, ]')).toEqual([1, 2]);
  });

  it("returns parsed json if completely valid", () => {
    expect(repairJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("returns null for completely unrepairable garbage", () => {
    expect(repairJson('hello world')).toBeNull();
  });
});
