import type { ProviderAdapter, ProviderErrorDetails } from "./types.js";

export const twilioAdapter: ProviderAdapter = {
  name: "twilio",
  displayName: "Twilio",
  formatError(details: ProviderErrorDetails) {
    const code = typeof details.code === "number" ? details.code : 21604;
    return {
      code,
      message: details.message,
      more_info: `https://www.twilio.com/docs/errors/${code}`,
      status: details.status
    };
  }
};
