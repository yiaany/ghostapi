import type { ProviderName } from "../providers/types.js";
import { getProviderAdapter } from "../providers/registry.js";
import type { ProviderErrorDetails } from "../providers/types.js";

export function createProviderError(provider: ProviderName, details: ProviderErrorDetails): unknown {
  const adapter = getProviderAdapter(provider);
  return adapter.formatError(details);
}