import { betterAuth } from "better-auth";
import type { Pool } from "pg";
import type { HostedConfig } from "./config.js";

export function createAuth(config: HostedConfig, database: Pool) {
  return betterAuth({
    baseURL: config.publicUrl,
    secret: config.betterAuthSecret,
    database,
    emailAndPassword: { enabled: true },
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret
      }
    },
    advanced: {
      database: { generateId: "uuid" }
    }
  });
}
