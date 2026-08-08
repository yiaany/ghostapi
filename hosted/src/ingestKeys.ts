import type { PoolClient } from "pg";
import { sha256 } from "./crypto.js";

const MAX_EXPIRY_DAYS = 90;

export type ProvisionedIngestKey = {
  id: string;
  keyPrefix: string;
  secret: string;
  expiresAt: string;
};

export async function createIngestKey(client: PoolClient, input: {
  projectId: string;
  actorId: string;
  expiresInDays: number;
}): Promise<ProvisionedIngestKey> {
  if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > MAX_EXPIRY_DAYS) {
    throw new Error(`expiresInDays must be an integer between 1 and ${MAX_EXPIRY_DAYS}.`);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = crypto.randomUUID();
    const keyPrefix = randomHex(6);
    const secret = randomBase64Url(32);
    try {
      const inserted = await client.query<{ id: string; key_prefix: string; expires_at: string | Date }>(
        `insert into app.ci_ingest_keys (id, project_id, key_prefix, secret_sha256, scopes, expires_at)
         values ($1, $2, $3, $4, array['reports:write']::text[], now() + ($5::integer * interval '1 day'))
         returning id, key_prefix, expires_at`,
        [id, input.projectId, keyPrefix, await sha256(secret), input.expiresInDays]
      );
      const key = inserted.rows[0];
      if (key === undefined) throw new Error("Ingest key insert did not return a key.");

      await writeIngestKeyAuditEvent(client, input.projectId, input.actorId, "ci_ingest_key.created", key.id);
      return { id: key.id, keyPrefix: key.key_prefix, secret, expiresAt: new Date(key.expires_at).toISOString() };
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 2) throw error;
    }
  }

  throw new Error("Unable to provision CI ingest key.");
}

export async function revokeIngestKey(client: PoolClient, input: {
  projectId: string;
  keyId: string;
  actorId: string;
}): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `update app.ci_ingest_keys
        set revoked_at = now()
      where id = $1 and project_id = $2 and revoked_at is null
      returning id`,
    [input.keyId, input.projectId]
  );
  const key = result.rows[0];
  if (key === undefined) return false;
  await writeIngestKeyAuditEvent(client, input.projectId, input.actorId, "ci_ingest_key.revoked", key.id);
  return true;
}

async function writeIngestKeyAuditEvent(client: PoolClient, projectId: string, actorId: string, action: string, keyId: string): Promise<void> {
  await client.query(
    `insert into app.audit_events (organization_id, actor_id, action, resource_type, resource_id)
     select organization_id, $2, $3, 'ci_ingest_key', $4
       from app.projects
      where id = $1`,
    [projectId, actorId, action, keyId]
  );
}

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

function randomBase64Url(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
