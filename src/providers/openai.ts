import type { ProviderAdapter, ProviderErrorDetails } from "./types.js";

export const openaiAdapter: ProviderAdapter = {
  name: "openai",
  displayName: "OpenAI",
  formatError(details: ProviderErrorDetails) {
    return {
      error: {
        message: details.message,
        type: details.type ?? "invalid_request_error",
        param: details.param ?? null,
        code: details.code ?? null
      }
    };
  }
};
