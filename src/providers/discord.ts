import type { ProviderAdapter, ProviderErrorDetails } from "./types.js";

export const discordAdapter: ProviderAdapter = {
  name: "discord",
  displayName: "Discord",
  formatError(details: ProviderErrorDetails) {
    return {
      code: typeof details.code === "number" ? details.code : 50035,
      message: details.message
    };
  }
};
