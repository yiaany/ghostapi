import { discordAdapter } from "./discord.js";
import { genericAdapter } from "./generic.js";
import { githubAdapter } from "./github.js";
import { openaiAdapter } from "./openai.js";
import { resendAdapter } from "./resend.js";
import { stripeAdapter } from "./stripe.js";
import { twilioAdapter } from "./twilio.js";
import type { ProviderAdapter, ProviderName } from "./types.js";

export const providerRegistry = {
  stripe: stripeAdapter,
  twilio: twilioAdapter,
  resend: resendAdapter,
  github: githubAdapter,
  discord: discordAdapter,
  openai: openaiAdapter,
  generic: genericAdapter
} satisfies Record<ProviderName, ProviderAdapter>;

export function getProviderAdapter(provider: ProviderName): ProviderAdapter {
  return providerRegistry[provider];
}

export function isRegisteredProvider(value: string): value is ProviderName {
  return Object.hasOwn(providerRegistry, value);
}
