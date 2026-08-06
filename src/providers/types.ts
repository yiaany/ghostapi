import type { IncomingHttpHeaders } from "node:http";
import type { NormalizedRequest } from "../proxy/requestNormalizer.js";

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

export type ProviderDetectionInput = {
  path: string;
  headers?: IncomingHttpHeaders | Record<string, string | string[]>;
  query?: Record<string, unknown>;
  body?: unknown;
};

export type ProviderPackDetectionInput = Pick<ProviderDetectionInput, "path">;

export type ProviderResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export type ProviderStateTransition = {
  key: string;
  value: unknown;
};

export type ProviderScenarioStep = {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export type ProviderScenario = {
  id: string;
  title: string;
  provider: string;
  description: string;
  steps: ProviderScenarioStep[];
};

export type ProviderRuntimeCapabilities = {
  clock: { now: () => Date };
  idGenerator: { create: (prefix: string) => string };
};

export type ProviderRuntime = {
  requireCapability<Name extends keyof ProviderRuntimeCapabilities>(name: Name): ProviderRuntimeCapabilities[Name];
};

export type ProviderPackCapabilities = {
  detection: boolean;
  requestParsing: boolean;
  validation: boolean;
  deterministicResponses: boolean;
  stateTransitions: boolean;
  providerErrors: boolean;
  scenarios: boolean;
  webhooks: boolean;
  conformanceFixtures: boolean;
};

export type ProviderPackManifest = {
  schemaVersion: 1;
  name: ProviderName;
  displayName: string;
  implementation: "pack" | "legacy" | "fallback";
  packVersion: string | null;
  apiVersions: { default: string; supported: string[] } | null;
  capabilities: ProviderPackCapabilities;
};

export type ProviderPackExecution = {
  pack: ProviderPack;
  apiVersion: string;
  parsedRequest: unknown;
  runtime: ProviderRuntime;
};

export type ProviderApiVersionResult =
  | { version: string; error?: never }
  | { version?: never; error: ProviderErrorDetails };

export type ProviderWebhookHook = {
  eventTypes: readonly string[];
  createEvents: (input: {
    request: NormalizedRequest;
    response: ProviderResponse;
    apiVersion: string;
    runtime: ProviderRuntime;
  }) => readonly unknown[];
};

export type ProviderConformanceFixture = {
  name: string;
  request: NormalizedRequest;
  assertResponse: (response: ProviderResponse) => string | null;
  assertStateTransition: (transition: ProviderStateTransition | null, response: ProviderResponse) => string | null;
};

export type ProviderPack = ProviderAdapter & {
  manifest: ProviderPackManifest & { implementation: "pack"; packVersion: string; apiVersions: { default: string; supported: string[] } };
  detection: {
    priority: number;
    matches: (input: ProviderPackDetectionInput) => boolean;
  };
  parseRequest: (request: NormalizedRequest) => unknown;
  selectApiVersion: (request: NormalizedRequest) => ProviderApiVersionResult;
  validate: (parsedRequest: unknown, request: NormalizedRequest) => ProviderErrorDetails | null;
  handleDeterministic: (input: {
    request: NormalizedRequest;
    parsedRequest: unknown;
    apiVersion: string;
    runtime: ProviderRuntime;
  }) => ProviderResponse;
  transitionState: (input: {
    request: NormalizedRequest;
    response: ProviderResponse;
    apiVersion: string;
    runtime: ProviderRuntime;
  }) => ProviderStateTransition | null;
  promptHints: readonly string[];
  scenarios: readonly ProviderScenario[];
  webhooks?: ProviderWebhookHook;
  conformanceFixtures: readonly ProviderConformanceFixture[];
};
