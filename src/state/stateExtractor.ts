import { isJsonObject } from "../utils/json.js";
import type { NormalizedRequest } from "../proxy/requestNormalizer.js";

const ID_FIELDS = ["id", "sid", "uuid", "name", "number"];

export function extractIdFromResponse(responseBody: unknown): string | undefined {
  if (!isJsonObject(responseBody)) {
    return undefined;
  }

  for (const field of ID_FIELDS) {
    const value = responseBody[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (typeof value === "number") {
      return value.toString();
    }
  }

  return undefined;
}

export function extractIdFromPath(request: NormalizedRequest): string | undefined {
  const { path } = request;
  const segments = path.split("/").filter(Boolean);
  
  if (segments.length === 0) return undefined;

  const lastSegment = segments[segments.length - 1];
  if (lastSegment === undefined) return undefined;

  // Test explicitly for ID-like shapes
  if (lastSegment.includes("_") || lastSegment.includes("-") || /\d/.test(lastSegment)) {
    return lastSegment;
  }

  // Pure generic fallback for test mocks like "/v1/customers/1"
  if (segments.length >= 2 && !lastSegment.match(/^[a-z]+s$/i)) {
    return lastSegment;
  }

  return undefined;
}