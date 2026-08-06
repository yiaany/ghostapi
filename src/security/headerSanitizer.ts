import type { IncomingHttpHeaders } from "node:http";
import { createHash } from "node:crypto";
import { sanitizeSecrets } from "./secrets.js";

export type SanitizedHeaders = Record<string, string | string[]>;

export function sanitizeHeaders(headers: IncomingHttpHeaders): SanitizedHeaders {
  const sanitized = sanitizeSecrets(headers);

  if (sanitized === null || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return {};
  }

  const result = Object.fromEntries(
    Object.entries(sanitized as Record<string, unknown>).filter(
      (entry): entry is [string, string | string[]] => typeof entry[1] === "string" || isStringArray(entry[1])
    )
  );
  const idempotencyKey = headers["idempotency-key"];
  if (typeof idempotencyKey === "string") result["idempotency-key"] = digestIdempotencyKey(idempotencyKey);
  if (isStringArray(idempotencyKey)) result["idempotency-key"] = idempotencyKey.map(digestIdempotencyKey);
  return result;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function digestIdempotencyKey(value: string): string {
  return `idempotency_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
