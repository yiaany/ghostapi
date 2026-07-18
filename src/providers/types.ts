export type ProviderName = "stripe" | "twilio" | "resend" | "github" | "discord" | "openai" | "generic";

export type ProviderErrorDetails = {
  status: number;
  message: string;
  code?: string | number;
  param?: string;
  type?: string;
};

export type ProviderAdapter = {
  name: ProviderName;
  displayName: string;
  formatError: (details: ProviderErrorDetails) => unknown;
};
