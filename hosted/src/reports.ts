import type { Pool, PoolClient } from "pg";
import { constantTimeHexEqual, sha256, stableJson } from "./crypto.js";
import { enforceQuota, organizationIdForProject } from "./quotas.js";

const MAX_REPORT_BYTES = 512 * 1024;
const IDEMPOTENCY_RETENTION_DAYS = 7;

export class ReportInputError extends Error {}
export class ReportAuthenticationError extends Error {}
export class IdempotencyConflictError extends Error {}

export type ReportPayload = {
  schemaVersion: 1;
  runId: string;
  payload: Record<string, unknown>;
};

export type AcceptedReport = { reportId: string; status: "accepted" | "duplicate" };

export async function authenticateIngestKey(primary: Pool, projectId: string, keyId: string, token: string): Promise<string> {
  const key = await primary.query<{ id: string; project_id: string; secret_sha256: string }>(
    `select id, project_id, secret_sha256
       from app.ci_ingest_keys
      where id = $1 and project_id = $2 and revoked_at is null and expires_at > now()
        and scopes @> array['reports:write']::text[]`,
    [keyId, projectId]
  );
  const record = key.rows[0];
  if (record === undefined || !constantTimeHexEqual(record.secret_sha256, await sha256(token))) throw new ReportAuthenticationError("Invalid ingest credential.");
  return record.id;
}

export async function markIngestKeyUsed(primary: Pick<Pool, "query">, projectId: string, keyId: string): Promise<void> {
  await primary.query("update app.ci_ingest_keys set last_used_at = now() where id = $1 and project_id = $2", [keyId, projectId]);
}

export async function acceptReport(client: PoolClient, input: {
  projectId: string;
  ingestKeyId: string;
  idempotencyKey: string;
  report: ReportPayload;
}): Promise<AcceptedReport> {
  validateIdempotencyKey(input.idempotencyKey);
  validateReport(input.report);

  const requestHash = await sha256(stableJson(input.report));
  const reportId = crypto.randomUUID();
  const ledger = await client.query<{ report_id: string; request_sha256: string }>(
    `insert into app.idempotency_ledger (project_id, key, request_sha256, report_id, expires_at)
     values ($1, $2, $3, $4, now() + ($5::integer * interval '1 day'))
     on conflict (project_id, key) do nothing
     returning report_id, request_sha256`,
    [input.projectId, input.idempotencyKey, requestHash, reportId, IDEMPOTENCY_RETENTION_DAYS]
  );

  if (ledger.rows[0] === undefined) {
    const existing = await client.query<{ report_id: string; request_sha256: string }>(
      "select report_id, request_sha256 from app.idempotency_ledger where project_id = $1 and key = $2 for update",
      [input.projectId, input.idempotencyKey]
    );
    const record = existing.rows[0];
    if (record === undefined) throw new Error("Idempotency record disappeared.");
    if (!constantTimeHexEqual(record.request_sha256, requestHash)) throw new IdempotencyConflictError("Idempotency-Key was reused with a different request.");
    return { reportId: record.report_id, status: "duplicate" };
  }


  const organizationId = await organizationIdForProject(client, input.projectId);
  if (organizationId === null) throw new ReportInputError("Project is unavailable.");
  await enforceQuota(client, organizationId, "reports");

  await client.query(
    `insert into app.reports (id, project_id, ingest_key_id, schema_version, run_id, payload_sha256, payload)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [reportId, input.projectId, input.ingestKeyId, input.report.schemaVersion, input.report.runId, requestHash, JSON.stringify(input.report.payload)]
  );
  const eventId = crypto.randomUUID();
  await client.query(
    `insert into app.outbox_events (id, event_type, aggregate_id, payload)
     values ($1, 'report.accepted', $2, $3::jsonb)`,
    [eventId, reportId, JSON.stringify({ schemaVersion: 1, eventId, reportId })]
  );
  return { reportId, status: "accepted" };
}

export function validateReport(value: ReportPayload): void {
  if (value.schemaVersion !== 1 || !isIdentifier(value.runId, 128) || !isPlainObject(value.payload)) throw new ReportInputError("Report payload is invalid.");
  rejectSensitiveValue(value.payload, 0);
  const encoded = stableJson(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_REPORT_BYTES) throw new ReportInputError(`Report payload exceeds ${MAX_REPORT_BYTES} bytes.`);
}

function validateIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9._:-]{16,256}$/.test(value)) throw new ReportInputError("Idempotency-Key must contain 16-256 safe characters.");
}

function isIdentifier(value: string, max: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function rejectSensitiveValue(value: unknown, depth: number, key?: string): void {
  if (depth > 8) throw new ReportInputError("Report payload is too deeply nested.");
  if (key !== undefined && ["authorization", "cookie", "set-cookie", "rawbody", "password", "secret", "token"].some((name) => key.toLowerCase().includes(name))) throw new ReportInputError("Report payload contains an unsafe field.");
  if (typeof value === "string") {
    if (value.length > 64 * 1024 || /(?:sk_live_|sk_test_|ghp_|xox[baprs]-|Bearer\s+[A-Za-z0-9._~+/-]{12,})/i.test(value)) throw new ReportInputError("Report payload contains a secret-shaped value.");
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new ReportInputError("Report payload contains too many entries.");
    for (const entry of value) rejectSensitiveValue(entry, depth + 1, key);
    return;
  }
  if (!isPlainObject(value)) throw new ReportInputError("Report payload must contain JSON values only.");
  const entries = Object.entries(value);
  if (entries.length > 1_000) throw new ReportInputError("Report payload contains too many fields.");
  for (const [childKey, child] of entries) rejectSensitiveValue(child, depth + 1, childKey);
}
