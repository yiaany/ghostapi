import type { Request } from "express";
import { sanitizeHeaders } from "../security/headerSanitizer.js";
import { sanitizeSecrets, sanitizeSecretString } from "../security/secrets.js";

export type NormalizedRequest = {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string | string[]>;
  body: unknown;
  receivedAt: string;
};

export function normalizeRequest(request: Request): NormalizedRequest {
  const normalized: NormalizedRequest = {
    method: request.method,
    path: sanitizeSecretString(request.path),
    query: sanitizeRecord(request.query),
    headers: sanitizeHeaders(request.headers),
    body: sanitizeSecrets(getSafeBody(request)),
    receivedAt: new Date().toISOString(),
  };

  return normalized;
}

function getSafeBody(request: Request): unknown {
  if (Buffer.isBuffer(request.body)) {
    return `[Binary Data: ${request.body.length} bytes]`;
  }
  return request.body;
}

function sanitizeRecord(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeSecrets(value);

  if (
    sanitized === null ||
    typeof sanitized !== "object" ||
    Array.isArray(sanitized)
  ) {
    return {};
  }

  return sanitized as Record<string, unknown>;
}
