export type HostedConfig = {
  port: number;
  publicUrl: string;
  allowedOrigin: string;
  databaseUrl: string;
  databaseReadUrl?: string;
  authDatabaseUrl: string;
  betterAuthSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  redisUrl: string;
  redisToken: string;
  ciIngestLimitPerMinute: number;
  qstashToken: string;
  qstashCurrentSigningKey: string;
  qstashNextSigningKey: string;
  qstashCallbackUrl: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): HostedConfig {
  const publicUrl = requiredUrl(env, "HOSTED_PUBLIC_URL");
  const allowedOrigin = requiredUrl(env, "HOSTED_ALLOWED_ORIGIN");
  const port = integer(env.PORT ?? "3000", "PORT", 1, 65_535);
  const betterAuthSecret = required(env, "BETTER_AUTH_SECRET");

  if (betterAuthSecret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters.");

  return {
    port,
    publicUrl,
    allowedOrigin,
    databaseUrl: required(env, "DATABASE_URL"),
    databaseReadUrl: optional(env, "DATABASE_READ_URL"),
    authDatabaseUrl: required(env, "AUTH_DATABASE_URL"),
    betterAuthSecret,
    googleClientId: required(env, "GOOGLE_CLIENT_ID"),
    googleClientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
    redisUrl: requiredUrl(env, "UPSTASH_REDIS_REST_URL"),
    redisToken: required(env, "UPSTASH_REDIS_REST_TOKEN"),
    ciIngestLimitPerMinute: integer(env.CI_INGEST_LIMIT_PER_MINUTE ?? "300000", "CI_INGEST_LIMIT_PER_MINUTE", 1, 1_000_000),
    qstashToken: required(env, "QSTASH_TOKEN"),
    qstashCurrentSigningKey: required(env, "QSTASH_CURRENT_SIGNING_KEY"),
    qstashNextSigningKey: required(env, "QSTASH_NEXT_SIGNING_KEY"),
    qstashCallbackUrl: requiredUrl(env, "QSTASH_CALLBACK_URL")
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required.`);
  return value;
}

function optional(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requiredUrl(env: Record<string, string | undefined>, name: string): string {
  const value = required(env, name);
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use https.`);
  return url.toString().replace(/\/$/, "");
}

function integer(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return parsed;
}
