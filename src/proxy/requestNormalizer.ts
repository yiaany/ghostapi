import type { Request } from "express";
import { sanitizeHeaders } from "../security/headerSanitizer.js";
import { sanitizeSecrets } from "../security/secrets.js";

export type NormalizedRequest = {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string | string[]>;
  body: unknown;
  rawBody?: string;
  receivedAt: string;
};

export function normalizeRequest(request: Request): NormalizedRequest {
  const normalized: NormalizedRequest = {
    method: request.method,
    path: request.path,
    query: sanitizeRecord(request.query),
    headers: sanitizeHeaders(request.headers),
    body: sanitizeSecrets(getSafeBody(request)),
    receivedAt: new Date().toISOString()
  };

  if (request.rawBody !== undefined) {
    normalized.rawBody = request.rawBody;
  }

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

  if (sanitized === null || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return {};
  }

  return sanitized as Record<string, unknown>;
}
