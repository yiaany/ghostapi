import type { ProviderName, ProviderErrorDetails } from "../providers/types.js";
import { createProviderError } from "../errors/index.js";

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

let config: FaultLabConfig = { ...DEFAULT_CONFIG };

export function getFaultLabConfig(): FaultLabConfig {
  return { ...config };
}

export function updateFaultLabConfig(input: unknown): FaultLabConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Fault Lab config must be a JSON object.");
  }

  const record = input as Record<string, unknown>;
  const nextConfig = {
    enabled: readBoolean(record.enabled, config.enabled),
    latencyMs: readInteger(record.latencyMs, config.latencyMs, 0, 10_000),
    latencyMinMs: readInteger(record.latencyMinMs, config.latencyMinMs, 0, 10_000),
    latencyMaxMs: readInteger(record.latencyMaxMs, config.latencyMaxMs, 0, 10_000),
    errorRate: readInteger(record.errorRate, config.errorRate, 0, 100),
    statusCode: readStatusCode(record.statusCode, config.statusCode),
    retryAfterSeconds: readInteger(record.retryAfterSeconds, config.retryAfterSeconds, 0, 120)
  };

  if (nextConfig.latencyMaxMs < nextConfig.latencyMinMs) {
    throw new Error("Fault Lab latencyMaxMs must be greater than or equal to latencyMinMs.");
  }

  config = nextConfig;

  return getFaultLabConfig();
}

export function resetFaultLabForTests(): void {
  config = { ...DEFAULT_CONFIG };
}

export function decideFault(provider: ProviderName, random = Math.random): FaultLabDecision {
  if (!config.enabled) return { type: "off" };

  const shouldInjectChaos = config.errorRate > 0 && random() * 100 < config.errorRate;
  if (!shouldInjectChaos) return { type: "off" };

  const action = Math.floor(random() * 3);
  if (action === 2) return { type: "delay", latencyMs: pickLatency(random) };

  const statusCode = action === 0 ? 429 : config.statusCode === 429 ? 503 : config.statusCode;

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

function pickLatency(random: () => number): number {
  if (config.latencyMs > 0) return config.latencyMs;
  const range = config.latencyMaxMs - config.latencyMinMs;
  return config.latencyMinMs + Math.round(random() * range);
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
