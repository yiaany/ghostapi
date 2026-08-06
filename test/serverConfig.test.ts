import { describe, expect, it, vi } from "vitest";
import { askLLM } from "../src/ai/aiClient.js";
import { loadServerConfig } from "../src/config/serverConfig.js";

describe("server configuration security defaults", () => {
  it("ignores ambient OPENAI_API_KEY without GhostAPI opt-in", () => {
    const config = loadServerConfig({ OPENAI_API_KEY: "ambient-secret" }, [], {});

    expect(config.allowExternalLlm).toBe(false);
    expect(config.apiKey).toBeUndefined();
  });

  it("requires both explicit opt-in and the GhostAPI-specific key", () => {
    const withoutOptIn = loadServerConfig({ GHOSTAPI_LLM_API_KEY: "ghost-secret" }, [], {});
    const withOptIn = loadServerConfig({ GHOSTAPI_ALLOW_EXTERNAL_LLM: "true", GHOSTAPI_LLM_API_KEY: "ghost-secret" }, [], {});

    expect(withoutOptIn.apiKey).toBeUndefined();
    expect(withOptIn).toMatchObject({ allowExternalLlm: true, apiKey: "ghost-secret" });
  });

  it("keeps offline mode authoritative over external opt-in", () => {
    const config = loadServerConfig({ GHOSTAPI_OFFLINE: "true", GHOSTAPI_ALLOW_EXTERNAL_LLM: "true", GHOSTAPI_LLM_API_KEY: "ghost-secret" }, [], {});

    expect(config).toMatchObject({ offline: true, allowExternalLlm: false });
    expect(config.apiKey).toBeUndefined();
  });

  it("does not call fetch when the client lacks explicit capability", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(askLLM([{ role: "user", content: "test" }], {
      host: "127.0.0.1",
      port: 8080,
      model: "gpt-4o-mini",
      apiKey: "ambient-secret"
    })).rejects.toThrow("explicit opt-in");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
