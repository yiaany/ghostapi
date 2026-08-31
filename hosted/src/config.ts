export type HostedConfig = {
  port: number;
  publicUrl: string;
  allowedOrigins: string[];
  databaseUrl: string;
  databaseReadUrl?: string;
  authDatabaseUrl: string;
  betterAuthSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  redisUrl: string;
  redisToken: string;
  ciIngestLimitPerMinute: number;
  organizationCreateLimitPerHour: number;
  qstashToken: string;
  qstashCurrentSigningKey: string;
  qstashNextSigningKey: string;
  qstashCallbackUrl: string;
  outboxMaxAttempts: number;
  workerMaxAttempts: number;
  reportRetentionDays: number;
  auditRetentionDays: number;
};

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): HostedConfig {
  const publicUrl = requiredUrl(env, "HOSTED_PUBLIC_URL");
  const allowedOrigins = required(env, "HOSTED_ALLOWED_ORIGINS")
    .split(",")
    .map((value) => secureOrigin(value.trim(), "HOSTED_ALLOWED_ORIGINS"));
  const port = integer(env.PORT ?? "3000", "PORT", 1, 65_535);
  const betterAuthSecret = required(env, "BETTER_AUTH_SECRET");

  if (betterAuthSecret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters.");

  return {
    port,
    publicUrl,
    allowedOrigins: [...new Set(allowedOrigins)],
    databaseUrl: required(env, "DATABASE_URL"),
    databaseReadUrl: optional(env, "DATABASE_READ_URL"),
    authDatabaseUrl: required(env, "AUTH_DATABASE_URL"),
    betterAuthSecret,
    googleClientId: required(env, "GOOGLE_CLIENT_ID"),
    googleClientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
    redisUrl: requiredUrl(env, "UPSTASH_REDIS_REST_URL"),
    redisToken: required(env, "UPSTASH_REDIS_REST_TOKEN"),
    ciIngestLimitPerMinute: integer(
      env.CI_INGEST_LIMIT_PER_MINUTE ?? "60",
      "CI_INGEST_LIMIT_PER_MINUTE",
      1,
      10_000,
    ),
    organizationCreateLimitPerHour: integer(
      env.ORGANIZATION_CREATE_LIMIT_PER_HOUR ?? "10",
      "ORGANIZATION_CREATE_LIMIT_PER_HOUR",
      1,
      1_000,
    ),
    qstashToken: required(env, "QSTASH_TOKEN"),
    qstashCurrentSigningKey: required(env, "QSTASH_CURRENT_SIGNING_KEY"),
    qstashNextSigningKey: required(env, "QSTASH_NEXT_SIGNING_KEY"),
    qstashCallbackUrl: requiredUrl(env, "QSTASH_CALLBACK_URL"),
    outboxMaxAttempts: integer(
      env.OUTBOX_MAX_ATTEMPTS ?? "10",
      "OUTBOX_MAX_ATTEMPTS",
      1,
      100,
    ),
    workerMaxAttempts: integer(
      env.WORKER_MAX_ATTEMPTS ?? "5",
      "WORKER_MAX_ATTEMPTS",
      1,
      20,
    ),
    reportRetentionDays: integer(
      env.REPORT_RETENTION_DAYS ?? "90",
      "REPORT_RETENTION_DAYS",
      1,
      3650,
    ),
    auditRetentionDays: integer(
      env.AUDIT_RETENTION_DAYS ?? "365",
      "AUDIT_RETENTION_DAYS",
      1,
      3650,
    ),
  };
}

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required.`);
  return value;
}

function optional(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requiredUrl(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = required(env, name);
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use https.`);
  return url.toString().replace(/\/$/, "");
}

function secureOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error(`${name} entries must be HTTPS origins.`);
  return url.origin;
}

function integer(
  value: string,
  name: string,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return parsed;
}
