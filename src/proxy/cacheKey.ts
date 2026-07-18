import { createHash } from "node:crypto";
import type { NormalizedRequest } from "./requestNormalizer.js";

type CacheInput = {
  provider: string;
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  importantHeaders: Record<string, string | string[]>;
};

export function createCacheKey(normalizedRequest: NormalizedRequest, provider: string): string {
  const input: CacheInput = {
    provider,
    method: normalizedRequest.method,
    path: normalizedRequest.path,
    query: sortObject(normalizedRequest.query),
    body: normalizedRequest.body,
    importantHeaders: extractImportantHeaders(normalizedRequest.headers)
  };

  return createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 10);
}

function extractImportantHeaders(headers: NormalizedRequest["headers"]): Record<string, string | string[]> {
  const importantKeys = ["content-type", "accept", "stripe-version", "x-github-api-version", "twilio-version"];
  const result: Record<string, string | string[]> = {};

  for (const key of importantKeys) {
    if (headers[key] !== undefined) {
      result[key] = headers[key];
    }
  }

  return sortObject(result);
}

function sortObject<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).sort(([left], [right]) => left.localeCompare(right))) as T;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    const stringifiedArr = value.map(stableStringify).sort();
    return `[${stringifiedArr.join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}