import { Pool, type PoolClient } from "pg";
import type { HostedConfig } from "./config.js";

export type Database = {
  primary: Pool;
  reader: Pool;
  auth: Pool;
  transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export function createDatabase(config: HostedConfig): Database {
  const primary = createPool(config.databaseUrl, "ghostapi-hosted-primary");
  const reader =
    config.databaseReadUrl === undefined
      ? primary
      : createPool(config.databaseReadUrl, "ghostapi-hosted-reader");
  const auth = createPool(config.authDatabaseUrl, "ghostapi-hosted-auth");

  return {
    primary,
    reader,
    auth,
    async transaction<T>(
      operation: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      const client = await primary.connect();
      try {
        await client.query("begin");
        const result = await operation(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await Promise.all([
        primary.end(),
        reader === primary ? Promise.resolve() : reader.end(),
        auth.end(),
      ]);
    },
  };
}

function createPool(connectionString: string, applicationName: string): Pool {
  return new Pool({
    connectionString,
    application_name: applicationName,
    max: 20,
    min: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    maxLifetimeSeconds: 300,
  });
}
