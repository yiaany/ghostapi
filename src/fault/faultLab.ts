import type { ProviderName, ProviderErrorDetails } from "../providers/types.js";
import { createProviderError } from "../errors/index.js";
import { getDataPaths } from "../config/dataPaths.js";
import { atomicWriteJson, mutateJsonFile, readJsonFile, withFileLock } from "../storage/fileStore.js";

export type FaultLabConfig = {
  enabled: boolean;
  latencyMs: number;
  latencyMinMs: number;
  latencyMaxMs: number;
  errorRate: number;
  statusCode: 429 | 500 | 502 | 503;
  retryAfterSeconds: number;
};

export type FaultLabDecision =
  | { type: "off" }
  | { type: "delay"; latencyMs: number }
  | { type: "error"; latencyMs: number; statusCode: FaultLabConfig["statusCode"]; retryAfterSeconds: number; body: unknown };

const DEFAULT_CONFIG: FaultLabConfig = {
  enabled: false,
  latencyMs: 0,
  latencyMinMs: 2_000,
  latencyMaxMs: 5_000,
  errorRate: 15,
  statusCode: 429,
  retryAfterSeconds: 2
};

export async function initializeFaultLab(): Promise<void> {
  const faultLabPath = getDataPaths().faultLab;
  await withFileLock(faultLabPath, async () => {
    const config = await readPersistedConfig();
    await atomicWriteJson(faultLabPath, config);
  });
}

export async function getFaultLabConfig(): Promise<FaultLabConfig> {
  return readPersistedConfig();
}

export async function updateFaultLabConfig(input: unknown): Promise<FaultLabConfig> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Fault Lab config must be a JSON object.");
  }

  const record = input as Record<string, unknown>;
  return mutateJsonFile(getDataPaths().faultLab, DEFAULT_CONFIG, sanitizeConfig, (current) => validateConfig({
    enabled: readBoolean(record.enabled, current.enabled),
    latencyMs: readInteger(record.latencyMs, current.latencyMs, 0, 10_000),
    latencyMinMs: readInteger(record.latencyMinMs, current.latencyMinMs, 0, 10_000),
    latencyMaxMs: readInteger(record.latencyMaxMs, current.latencyMaxMs, 0, 10_000),
    errorRate: readInteger(record.errorRate, current.errorRate, 0, 100),
    statusCode: readStatusCode(record.statusCode, current.statusCode),
    retryAfterSeconds: readInteger(record.retryAfterSeconds, current.retryAfterSeconds, 0, 120)
  }));
}

export async function resetFaultLabForTests(): Promise<void> {
  const faultLabPath = getDataPaths().faultLab;
  await withFileLock(faultLabPath, () => atomicWriteJson(faultLabPath, DEFAULT_CONFIG));
}

export async function decideFault(provider: ProviderName, random = Math.random): Promise<FaultLabDecision> {
  const config = await readPersistedConfig();
  if (!config.enabled) return { type: "off" };

  const shouldInjectChaos = config.errorRate > 0 && random() * 100 < config.errorRate;
  if (!shouldInjectChaos) return { type: "off" };

  const action = Math.floor(random() * 3);
  if (action === 2) return { type: "delay", latencyMs: pickLatency(config, random) };

  // An explicit 429 configuration must be reproducible for retry tests. Other
  // configured provider failures retain the existing 5xx/429 error path.
  const statusCode = config.statusCode;

  return {
    type: "error",
    latencyMs: config.latencyMs,
    statusCode,
    retryAfterSeconds: config.retryAfterSeconds,
    body: createProviderError(provider, createFaultDetails(statusCode))
  };
}

export function waitForFault(latencyMs: number): Promise<void> {
  return latencyMs > 0 ? new Promise((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve();
}

function createFaultDetails(statusCode: FaultLabConfig["statusCode"]): ProviderErrorDetails {
  if (statusCode === 429) {
    return { status: 429, message: "Chaos Mode simulated rate limit. Please retry later.", type: "rate_limit_error", code: "rate_limit" };
  }

  return { status: statusCode, message: `Chaos Mode simulated upstream ${statusCode} response.`, type: "api_error", code: statusCode };
}

function pickLatency(config: FaultLabConfig, random: () => number): number {
  if (config.latencyMs > 0) return config.latencyMs;
  const range = config.latencyMaxMs - config.latencyMinMs;
  return config.latencyMinMs + Math.round(random() * range);
}

async function readPersistedConfig(): Promise<FaultLabConfig> {
  try {
    return await readJsonFile(getDataPaths().faultLab, DEFAULT_CONFIG, sanitizeConfig);
  } catch (error) {
    if (error instanceof SyntaxError) return { ...DEFAULT_CONFIG };
    throw error;
  }
}

function sanitizeConfig(value: unknown): FaultLabConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_CONFIG };
  const record = value as Record<string, unknown>;
  try {
    return validateConfig({
      enabled: readBoolean(record.enabled, DEFAULT_CONFIG.enabled),
      latencyMs: readInteger(record.latencyMs, DEFAULT_CONFIG.latencyMs, 0, 10_000),
      latencyMinMs: readInteger(record.latencyMinMs, DEFAULT_CONFIG.latencyMinMs, 0, 10_000),
      latencyMaxMs: readInteger(record.latencyMaxMs, DEFAULT_CONFIG.latencyMaxMs, 0, 10_000),
      errorRate: readInteger(record.errorRate, DEFAULT_CONFIG.errorRate, 0, 100),
      statusCode: readStatusCode(record.statusCode, DEFAULT_CONFIG.statusCode),
      retryAfterSeconds: readInteger(record.retryAfterSeconds, DEFAULT_CONFIG.retryAfterSeconds, 0, 120)
    });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function validateConfig(config: FaultLabConfig): FaultLabConfig {
  if (config.latencyMaxMs < config.latencyMinMs) {
    throw new Error("Fault Lab latencyMaxMs must be greater than or equal to latencyMinMs.");
  }
  return config;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Expected integer between ${min} and ${max}.`);
  }
  return value;
}

function readStatusCode(value: unknown, fallback: FaultLabConfig["statusCode"]): FaultLabConfig["statusCode"] {
  if (value === undefined) return fallback;
  if (value === 429 || value === 500 || value === 502 || value === 503) return value;
  throw new Error("Fault Lab statusCode must be one of 429, 500, 502, or 503.");
}
