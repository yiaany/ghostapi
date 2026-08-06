import type {
  ProviderPack,
  ProviderPackExecution,
  ProviderErrorDetails,
  ProviderRuntime,
  ProviderRuntimeCapabilities,
  ProviderStateTransition
} from "./types.js";
import type { NormalizedRequest } from "../proxy/requestNormalizer.js";

let defaultIdSequence = 0;

export function createProviderRuntime(overrides: Partial<ProviderRuntimeCapabilities> = {}): ProviderRuntime {
  const clock = overrides.clock ?? { now: () => new Date() };
  const capabilities: ProviderRuntimeCapabilities = {
    clock,
    idGenerator: overrides.idGenerator ?? {
      create: (prefix) => `${prefix}_${clock.now().getTime().toString(36)}${(defaultIdSequence += 1).toString(36).padStart(4, "0")}`
    },
    state: overrides.state ?? { snapshot: () => ({}) }
  };

  return {
    requireCapability(name) {
      if (!Object.hasOwn(capabilities, name)) {
        throw new Error(`Unknown provider capability: ${String(name)}`);
      }
      return capabilities[name];
    }
  };
}

const defaultProviderRuntime = createProviderRuntime();

export function prepareProviderPackExecution(pack: ProviderPack, request: NormalizedRequest, runtime: ProviderRuntime = defaultProviderRuntime): ProviderPackExecution | { error: ProviderErrorDetails } {
  const version = pack.selectApiVersion(request);
  if (version.error !== undefined) return { error: version.error };
  if (!pack.manifest.apiVersions.supported.includes(version.version)) {
    throw new Error(`Provider pack ${pack.name} selected undeclared API version: ${version.version}`);
  }

  return {
    pack,
    apiVersion: version.version,
    parsedRequest: pack.parseRequest(request),
    runtime
  };
}

export function getProviderPackHeaders(execution: ProviderPackExecution): Record<string, string> {
  return {
    "x-ghostapi-provider-pack": `${execution.pack.name}@${execution.pack.manifest.packVersion}`,
    "x-ghostapi-api-version": execution.apiVersion
  };
}

export function assertProviderStateTransition(pack: ProviderPack, transition: ProviderStateTransition): void {
  for (const write of [transition, ...(transition.additionalWrites ?? [])]) {
    if (!write.key.startsWith(`${pack.name}:`) || write.key.length <= pack.name.length + 1) {
      throw new Error(`Provider pack ${pack.name} returned an invalid state transition key.`);
    }
  }
}
