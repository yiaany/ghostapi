import { discordAdapter } from "./discord.js";
import { genericAdapter } from "./generic.js";
import { githubAdapter } from "./github.js";
import { openaiAdapter } from "./openai.js";
import { resendPack } from "./packs/resendPack.js";
import { stripeAdapter } from "./stripe.js";
import { twilioAdapter } from "./twilio.js";
import type { ProviderAdapter, ProviderName, ProviderPack, ProviderPackDetectionInput, ProviderPackManifest, ProviderScenario } from "./types.js";

export const providerRegistry = {
  stripe: stripeAdapter,
  twilio: twilioAdapter,
  resend: resendPack,
  github: githubAdapter,
  discord: discordAdapter,
  openai: openaiAdapter,
  generic: genericAdapter
} satisfies Record<ProviderName, ProviderAdapter>;

const providerPacks = [resendPack] satisfies ProviderPack[];
const providerPacksByPriority = [...providerPacks].sort((left, right) => right.detection.priority - left.detection.priority);

const legacyCapabilities: Record<ProviderName, ProviderPackManifest["capabilities"]> = {
  stripe: capabilities({ validation: true, scenarios: true }),
  twilio: capabilities({ validation: true }),
  resend: resendPack.manifest.capabilities,
  github: capabilities({ scenarios: true }),
  discord: capabilities(),
  openai: capabilities(),
  generic: capabilities()
};

export function getProviderAdapter(provider: ProviderName): ProviderAdapter {
  return providerRegistry[provider];
}

export function isRegisteredProvider(value: string): value is ProviderName {
  return Object.hasOwn(providerRegistry, value);
}

export function getProviderPack(provider: ProviderName): ProviderPack | null {
  return providerPacks.find((pack) => pack.name === provider) ?? null;
}

export function detectProviderPack(input: ProviderPackDetectionInput): ProviderName | null {
  const match = providerPacksByPriority.find((pack) => pack.detection.matches(input));
  return match?.name ?? null;
}

export function getProviderScenarios(): ProviderScenario[] {
  return providerPacks.flatMap((pack) => structuredClone(pack.scenarios));
}

export function getProviderManifests(): ProviderPackManifest[] {
  return Object.values(providerRegistry).map((adapter) => {
    const pack = getProviderPack(adapter.name);
    if (pack !== null) return structuredClone(pack.manifest);

    return {
      schemaVersion: 1,
      name: adapter.name,
      displayName: adapter.displayName,
      implementation: adapter.name === "generic" ? "fallback" : "legacy",
      packVersion: null,
      apiVersions: null,
      capabilities: structuredClone(legacyCapabilities[adapter.name])
    };
  });
}

function capabilities(overrides: Partial<ProviderPackManifest["capabilities"]> = {}): ProviderPackManifest["capabilities"] {
  return {
    detection: true,
    requestParsing: false,
    validation: false,
    deterministicResponses: true,
    stateTransitions: false,
    providerErrors: true,
    scenarios: false,
    webhooks: false,
    conformanceFixtures: false,
    ...overrides
  };
}
