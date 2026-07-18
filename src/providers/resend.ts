import type { ProviderAdapter, ProviderErrorDetails } from "./types.js";

export const resendAdapter: ProviderAdapter = {
  name: "resend",
  displayName: "Resend",
  formatError(details: ProviderErrorDetails) {
    return {
      statusCode: details.status,
      name: details.type ?? "validation_error",
      message: details.message
    };
  }
};
