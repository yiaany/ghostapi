import type { ProviderAdapter, ProviderErrorDetails } from "./types.js";

export const githubAdapter: ProviderAdapter = {
  name: "github",
  displayName: "GitHub",
  formatError(details: ProviderErrorDetails) {
    return {
      message: details.message,
      documentation_url: "https://docs.github.com/rest"
    };
  }
};
