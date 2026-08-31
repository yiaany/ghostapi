import type { IncomingHttpHeaders } from "node:http";
import { createHash } from "node:crypto";
import { sanitizeSecrets } from "./secrets.js";

export type SanitizedHeaders = Record<string, string | string[]>;
const SAFE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-language",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "link",
  "location",
  "retry-after",
  "stripe-signature",
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function sanitizeHeaders(
  headers: IncomingHttpHeaders,
): SanitizedHeaders {
  const sanitized = sanitizeSecrets(headers);

  if (
    sanitized === null ||
    typeof sanitized !== "object" ||
    Array.isArray(sanitized)
  ) {
    return {};
  }

  const result = Object.fromEntries(
    Object.entries(sanitized as Record<string, unknown>).filter(
      (entry): entry is [string, string | string[]] =>
        typeof entry[1] === "string" || isStringArray(entry[1]),
    ),
  );
  const idempotencyKey = headers["idempotency-key"];
  if (typeof idempotencyKey === "string")
    result["idempotency-key"] = digestIdempotencyKey(idempotencyKey);
  if (isStringArray(idempotencyKey))
    result["idempotency-key"] = idempotencyKey.map(digestIdempotencyKey);
  return result;
}

export function sanitizeResponseHeaders(
  value: unknown,
): Record<string, string | string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  const result: Record<string, string | string[]> = {};
  for (const [rawName, rawValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const name = rawName.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      BLOCKED_RESPONSE_HEADERS.has(name) ||
      (!SAFE_RESPONSE_HEADERS.has(name) && !isSafeResponseExtension(name))
    )
      continue;
    const values =
      typeof rawValue === "string"
        ? [rawValue]
        : isStringArray(rawValue)
          ? rawValue
          : [];
    if (
      values.length === 0 ||
      values.length > 16 ||
      values.some((entry) => entry.length > 4096 || /[\r\n\0]/.test(entry))
    )
      continue;
    if (
      name === "location" &&
      (typeof rawValue !== "string" || !isSafeRelativeLocation(rawValue))
    )
      continue;
    result[name] = typeof rawValue === "string" ? values[0]! : values;
  }
  return result;
}

export function isSafeRelativeLocation(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSafeResponseExtension(name: string): boolean {
  return (
    name === "x-request-id" ||
    name === "x-correlation-id" ||
    name.startsWith("x-ghostapi-") ||
    name.startsWith("x-ratelimit-") ||
    name.startsWith("x-github-") ||
    name.startsWith("x-stripe-")
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function digestIdempotencyKey(value: string): string {
  return `idempotency_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
