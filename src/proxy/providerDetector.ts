import type { IncomingHttpHeaders } from "node:http";
import { isRegisteredProvider, type ProviderName } from "../providers/index.js";

export type ProviderDetectionInput = {
  path: string;
  headers?: IncomingHttpHeaders | Record<string, string | string[]>;
  query?: Record<string, unknown>;
  body?: unknown;
};

export type Provider = ProviderName;

export function detectProvider(input: ProviderDetectionInput): Provider;
export function detectProvider(path: string, headers?: IncomingHttpHeaders): Provider;
export function detectProvider(inputOrPath: ProviderDetectionInput | string, headers: IncomingHttpHeaders = {}): Provider {
  const input = typeof inputOrPath === "string" ? { path: inputOrPath, headers } : inputOrPath;
  const normalizedPath = input.path.toLowerCase();
  const normalizedHeaders = normalizeHeaders(input.headers ?? {});
  const query = input.query ?? {};
  const body = input.body;
  const override = getProviderOverride(normalizedHeaders, query);

  if (override !== undefined) {
    return override;
  }

  if (isStripePath(normalizedPath) || normalizedHeaders["stripe-version"] !== undefined || hasStripeAuthorization(normalizedHeaders)) {
    return "stripe";
  }

  if (normalizedPath.includes("/2010-04-01/") || normalizedPath.includes("/accounts/")) {
    return "twilio";
  }

  if (normalizedPath === "/emails" || normalizedPath.startsWith("/emails/")) {
    return "resend";
  }

  if (normalizedPath.startsWith("/repos/") || normalizedPath.startsWith("/user/") || normalizedPath === "/user" || normalizedHeaders["x-github-api-version"] !== undefined) {
    return "github";
  }

  if (isOpenAiPath(normalizedPath) || normalizedHeaders["openai-organization"] !== undefined || normalizedHeaders["openai-project"] !== undefined) {
    return "openai";
  }

  if (
    /^\/api\/v\d+\/(?:channels|guilds|webhooks|interactions|applications)(?:\/|$)/.test(normalizedPath) ||
    normalizedPath.includes("/channels/") ||
    normalizedPath.includes("/webhooks/") ||
    hasKey(query, "guild_id") ||
    hasKey(query, "channel_id") ||
    hasKey(body, "guild_id") ||
    hasKey(body, "channel_id")
  ) {
    return "discord";
  }

  return "generic";
}

function isStripePath(path: string): boolean {
  return /^\/v1\/(?:customers|charges|payment_intents|setup_intents|checkout|prices|products|subscriptions|invoices|payment_methods|refunds|accounts|balance|payouts|transfers|events|webhook_endpoints)(?:\/|$)/.test(path);
}

function isOpenAiPath(path: string): boolean {
  return /^\/v1\/(?:chat\/completions|responses|embeddings|models|images|audio|files|fine_tuning|assistants|threads|vector_stores)(?:\/|$)/.test(path);
}

function getProviderOverride(headers: Record<string, string | string[]>, query: Record<string, unknown>): Provider | undefined {
  const headerOverride = firstValue(headers["x-ghostapi-provider"]);
  const queryOverride = typeof query.ghost_provider === "string" ? query.ghost_provider : undefined;
  const override = (headerOverride ?? queryOverride)?.toLowerCase();

  return override !== undefined && isRegisteredProvider(override) ? override : undefined;
}

function normalizeHeaders(headers: IncomingHttpHeaders | Record<string, string | string[]>): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string | string[]] => typeof entry[1] === "string" || isStringArray(entry[1]))
      .map(([key, value]) => [key.toLowerCase(), value])
  );
}

function hasStripeAuthorization(headers: Record<string, string | string[]>): boolean {
  const authorization = firstValue(headers.authorization);
  return authorization !== undefined && /(?:bearer\s+)?[sr]k_(?:live|test)_/i.test(authorization);
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasKey(entry, key));
  }

  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([entryKey, entryValue]) => entryKey === key || hasKey(entryValue, key));
  }

  return false;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
