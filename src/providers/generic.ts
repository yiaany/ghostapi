import type { ProviderAdapter, ProviderErrorDetails } from "./types.js";

export const genericAdapter: ProviderAdapter = {
  name: "generic",
  displayName: "Generic REST API",
  formatError(details: ProviderErrorDetails) {
    return {
      error: {
        status: details.status,
        message: details.message
      }
    };
  }
};
