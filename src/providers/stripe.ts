import type { ProviderAdapter, ProviderErrorDetails } from "./types.js";

export const stripeAdapter: ProviderAdapter = {
  name: "stripe",
  displayName: "Stripe",
  formatError(details: ProviderErrorDetails) {
    return {
      error: {
        type: details.type ?? "invalid_request_error",
        message: details.message,
        code: typeof details.code === "string" ? details.code : "parameter_missing",
        param: details.param ?? "unknown"
      }
    };
  }
};
