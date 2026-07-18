const SECRET_FIELD_NAMES = [
  "authorization",
  "api_key",
  "apikey",
  "x-api-key",
  "access_token",
  "refresh_token",
  "client_secret",
  "password",
  "secret",
  "token",
  "key"
];

const TOKEN_PATTERNS = [
  /sk_live_[A-Za-z0-9_\-]+/g,
  /sk_test_[A-Za-z0-9_\-]+/g,
  /rk_live_[A-Za-z0-9_\-]+/g,
  /ghp_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /xoxb-[A-Za-z0-9\-]+/g,
  /SG\.[A-Za-z0-9_\-\.]+/g
];

export const MASK = "***";

export function sanitizeSecrets(value: unknown): unknown {
  return sanitizeValue(value);
}

export function sanitizeSecretString(value: string): string {
  return TOKEN_PATTERNS.reduce((result, pattern) => result.replace(pattern, MASK), value.replace(/Bearer\s+\S+/gi, "Bearer ***"));
}

export function isSecretFieldName(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return SECRET_FIELD_NAMES.some((secretName) => normalizedName.includes(secretName));
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        isSecretFieldName(key) ? maskByType(entryValue) : sanitizeValue(entryValue)
      ])
    );
  }

  if (typeof value === "string") {
    return sanitizeSecretString(value);
  }

  return value;
}

function maskByType(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskByType);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).map((key) => [key, MASK]));
  }

  if (typeof value === "string" && value.trim().toLowerCase().startsWith("bearer ")) {
    return "Bearer ***";
  }

  return MASK;
}
