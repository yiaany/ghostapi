import { betterAuth } from "better-auth";
import type { Pool } from "pg";
import type { HostedConfig } from "./config.js";

export function createAuth(config: HostedConfig, database: Pool) {
  return betterAuth({
    baseURL: config.publicUrl,
    secret: config.betterAuthSecret,
    database,
    trustedOrigins: config.allowedOrigins,
    emailAndPassword: { enabled: true },
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
      },
    },
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: true,
      cookiePrefix: "ghostapi",
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 10,
    },
    account: { accountLinking: { enabled: false } },
  });
}
