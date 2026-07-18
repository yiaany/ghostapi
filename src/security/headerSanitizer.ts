import type { IncomingHttpHeaders } from "node:http";
import { sanitizeSecrets } from "./secrets.js";

export type SanitizedHeaders = Record<string, string | string[]>;

export function sanitizeHeaders(headers: IncomingHttpHeaders): SanitizedHeaders {
  const sanitized = sanitizeSecrets(headers);

  if (sanitized === null || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(sanitized as Record<string, unknown>).filter(
      (entry): entry is [string, string | string[]] => typeof entry[1] === "string" || isStringArray(entry[1])
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
