const SECRET_FIELD_NAMES = [
  "authorization",
  "cookie",
  "set-cookie",
  "api_key",
  "apikey",
  "x-api-key",
  "access_token",
  "refresh_token",
  "client_secret",
  "private_key",
  "privatekey",
  "signing_key",
  "webhook_secret",
  "session_id",
  "sessionid",
  "passphrase",
  "cvc",
  "password",
  "secret",
  "token",
  "key",
];

const TOKEN_PATTERNS = [
  /sk_live_[A-Za-z0-9_\-]+/g,
  /sk_test_[A-Za-z0-9_\-]+/g,
  /rk_live_[A-Za-z0-9_\-]+/g,
  /ghp_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /xoxb-[A-Za-z0-9\-]+/g,
  /SG\.[A-Za-z0-9_\-\.]+/g,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /ya29\.[0-9A-Za-z_-]+/g,
  /(?:eyJ[A-Za-z0-9_-]{8,})\.(?:[A-Za-z0-9_-]{8,})\.(?:[A-Za-z0-9_-]{8,})/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
  /(?:npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,})/g,
];

export const MASK = "***";

export function sanitizeSecrets(value: unknown): unknown {
  return sanitizeValue(value);
}

export function sanitizeSecretString(value: string): string {
  return TOKEN_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, MASK),
    value.replace(/Bearer\s+\S+/gi, "Bearer ***"),
  );
}

export function isSecretFieldName(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return SECRET_FIELD_NAMES.some((secretName) =>
    normalizedName.includes(secretName),
  );
}

function sanitizeValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, parentKey));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([key, entryValue]) => [
          key,
          isSecretFieldName(key) || isCardNumberField(key, parentKey)
            ? maskByType(entryValue)
            : sanitizeValue(entryValue, key),
        ],
      ),
    );
  }

  if (typeof value === "string") {
    return sanitizeSecretString(value);
  }

  return value;
}

function isCardNumberField(
  key: string,
  parentKey: string | undefined,
): boolean {
  return (
    key.toLowerCase() === "number" &&
    parentKey !== undefined &&
    /(?:card|payment_method)/i.test(parentKey)
  );
}

function maskByType(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskByType);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).map((key) => [key, MASK]),
    );
  }

  if (
    typeof value === "string" &&
    value.trim().toLowerCase().startsWith("bearer ")
  ) {
    return "Bearer ***";
  }

  return MASK;
}
