import { cors } from "@elysiajs/cors";
import { Elysia, t } from "elysia";
import { loadConfig } from "./config.js";
import { createAuth } from "./auth.js";
import { createDatabase, type Database } from "./db.js";
import { createIngestKey, revokeIngestKey } from "./ingestKeys.js";
import { authenticateIngestKey, acceptReport, IdempotencyConflictError, ReportAuthenticationError, ReportInputError, type ReportPayload } from "./reports.js";
import { createQueue, JobLeaseActiveError, processReportEvent, type ReportEvent } from "./worker.js";
import { createRateLimiter, RateLimitError, RateLimitUnavailableError } from "./rateLimit.js";
import { BoundedRequestBodyError, readBoundedRequestBody } from "./boundedBody.js";

const MAX_QUEUE_BODY_BYTES = 16 * 1024;

const reportBody = t.Object({
  schemaVersion: t.Literal(1),
  runId: t.String({ minLength: 1, maxLength: 128 }),
  payload: t.Record(t.String(), t.Unknown())
});

const scenarioBody = t.Object({
  version: t.Integer({ minimum: 1, maximum: 100_000 }),
  definition: t.Record(t.String(), t.Unknown())
});

const ingestKeyBody = t.Object({
  expiresInDays: t.Integer({ minimum: 1, maximum: 90 })
});

type Dependencies = {
  database: Database;
  auth: ReturnType<typeof createAuth>;
  queue: ReturnType<typeof createQueue>;
  rateLimiter: ReturnType<typeof createRateLimiter>;
};

export function createHostedApp(config: ReturnType<typeof loadConfig>, dependencies: Dependencies) {
  return new Elysia()
    .use(cors({ origin: config.allowedOrigin, credentials: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-ghostapi-ingest-key-id"] }))
    .mount(dependencies.auth.handler)
    .get("/healthz", () => ({ status: "ok" }))
    .get("/readyz", async ({ status }) => {
      await dependencies.database.primary.query("select 1");
      return status(200, { status: "ready" });
    })
    .post("/v1/projects/:projectId/reports", async ({ body, headers, params, status }) => {
      const contentLength = headers["content-length"];
      if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > 512 * 1024)) return status(413, { error: "payload_too_large" });
      const keyId = headers["x-ghostapi-ingest-key-id"];
      const authorization = headers.authorization;
      const idempotencyKey = headers["idempotency-key"];
      if (keyId === undefined || idempotencyKey === undefined || authorization === undefined || !authorization.startsWith("Bearer ")) return status(401, { error: "invalid_ingest_credentials" });

      try {
        const ingestKeyId = await authenticateIngestKey(dependencies.database.primary, params.projectId, keyId, authorization.slice("Bearer ".length));
        await dependencies.rateLimiter.consume(`ci:${params.projectId}`, config.ciIngestLimitPerMinute, 60_000);
        const accepted = await dependencies.database.transaction((client) => acceptReport(client, { projectId: params.projectId, ingestKeyId, idempotencyKey, report: body as ReportPayload }));
        return status(202, { reportId: accepted.reportId, status: accepted.status });
      } catch (error) {
        if (error instanceof ReportAuthenticationError) return status(401, { error: "invalid_ingest_credentials" });
        if (error instanceof IdempotencyConflictError) return status(409, { error: "idempotency_conflict" });
        if (error instanceof ReportInputError) return status(422, { error: "invalid_report" });
        if (error instanceof RateLimitError) return status(429, { error: "rate_limited", retryAfterSeconds: error.retryAfterSeconds });
        if (error instanceof RateLimitUnavailableError) return status(503, { error: "rate_limit_unavailable" });
        throw error;
      }
    }, { body: reportBody })
    .get("/v1/reports/:reportId", async ({ params, request, status, set }) => {
      const session = await dependencies.auth.api.getSession({ headers: request.headers });
      if (session === null) return status(404, { error: "not_found" });
      const result = await dependencies.database.primary.query<{ id: string; status: string; accepted_at: string; completed_at: string | null }>(
        `select report.id, report.status, report.accepted_at, report.completed_at
           from app.reports report
           join app.projects project on project.id = report.project_id
           join app.organization_memberships membership on membership.organization_id = project.organization_id
          where report.id = $1 and membership.user_id = $2`,
        [params.reportId, session.user.id]
      );
      const report = result.rows[0];
      if (report === undefined) return status(404, { error: "not_found" });
      set.headers["x-consistency"] = "primary";
      return report;
    })
    .get("/v1/projects/:projectId/scenarios/:scenarioKey", async ({ params, query, request, set, status }) => {
      const member = await requireProjectMember(dependencies, request, params.projectId, "viewer");
      if (member === null) return status(404, { error: "not_found" });
      const version = query.version === undefined ? null : Number(query.version);
      if (version !== null && (!Number.isInteger(version) || version < 1)) return status(422, { error: "invalid_version" });
      const result = await dependencies.database.primary.query<{ id: string; version: number; definition: Record<string, unknown>; definition_sha256: string; created_at: string }>(
        `select id, version, definition, definition_sha256, created_at
           from app.scenario_versions
          where project_id = $1 and scenario_key = $2 and ($3::integer is null or version = $3)
          order by version desc
          limit 1`,
        [params.projectId, params.scenarioKey, version]
      );
      const scenario = result.rows[0];
      if (scenario === undefined) return status(404, { error: "not_found" });
      set.headers["x-consistency"] = "primary";
      return scenario;
    })
    .post("/v1/projects/:projectId/scenarios/:scenarioKey", async ({ body, params, request, status }) => {
      const member = await requireProjectMember(dependencies, request, params.projectId, "developer");
      if (member === null) return status(404, { error: "not_found" });
      const definition = JSON.stringify(body.definition);
      if (Buffer.byteLength(definition, "utf8") > 256 * 1024) return status(413, { error: "definition_too_large" });
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(definition));
      try {
        const result = await dependencies.database.primary.query<{ id: string; version: number }>(
          `insert into app.scenario_versions (project_id, scenario_key, version, definition, definition_sha256, created_by)
           values ($1, $2, $3, $4::jsonb, $5, $6)
           returning id, version`,
          [params.projectId, params.scenarioKey, body.version, definition, Buffer.from(digest).toString("hex"), member.userId]
        );
        return status(201, result.rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) return status(409, { error: "scenario_version_conflict" });
        throw error;
      }
    }, { body: scenarioBody })
    .post("/v1/projects/:projectId/ingest-keys", async ({ body, params, request, status }) => {
      const member = await requireProjectMember(dependencies, request, params.projectId, "developer");
      if (member === null) return status(404, { error: "not_found" });
      const key = await dependencies.database.transaction((client) => createIngestKey(client, {
        projectId: params.projectId,
        actorId: member.userId,
        expiresInDays: body.expiresInDays
      }));
      return status(201, key);
    }, { body: ingestKeyBody })
    .post("/v1/projects/:projectId/ingest-keys/:keyId/revoke", async ({ params, request, status }) => {
      const member = await requireProjectMember(dependencies, request, params.projectId, "developer");
      if (member === null) return status(404, { error: "not_found" });
      const revoked = await dependencies.database.transaction((client) => revokeIngestKey(client, {
        projectId: params.projectId,
        keyId: params.keyId,
        actorId: member.userId
      }));
      if (!revoked) return status(404, { error: "not_found" });
      return status(200, { status: "revoked" });
    })
    .post("/internal/jobs/process-report", async ({ request, status }) => {
      const signature = request.headers.get("upstash-signature");
      if (signature === null) return status(401, { error: "missing_queue_signature" });
      let rawBody: string;
      try {
        rawBody = await readBoundedRequestBody(request, MAX_QUEUE_BODY_BYTES);
      } catch (error) {
        if (error instanceof BoundedRequestBodyError) return status(413, { error: "payload_too_large" });
        throw error;
      }
      const verified = await dependencies.queue.receiver.verify({ signature, body: rawBody, url: request.url });
      if (!verified) return status(401, { error: "invalid_queue_signature" });
      try {
        const result = await processReportEvent(dependencies.database, JSON.parse(rawBody) as ReportEvent);
        return status(200, { status: result });
      } catch (error) {
        if (error instanceof JobLeaseActiveError) return status(503, { error: "worker_lease_active" });
        throw error;
      }
    });
}

const config = loadConfig();
const database = createDatabase(config);
const auth = createAuth(config, database.auth);
const queue = createQueue(config);
const rateLimiter = createRateLimiter(config);
const app = createHostedApp(config, { database, auth, queue, rateLimiter });

app.listen({ port: config.port, hostname: "0.0.0.0" });

async function requireProjectMember(dependencies: Dependencies, request: Request, projectId: string, minimumRole: "viewer" | "developer"): Promise<{ userId: string } | null> {
  const session = await dependencies.auth.api.getSession({ headers: request.headers });
  if (session === null) return null;
  const membership = await dependencies.database.primary.query<{ role: "owner" | "admin" | "developer" | "viewer" }>(
    `select membership.role
       from app.organization_memberships membership
       join app.projects project on project.organization_id = membership.organization_id
      where project.id = $1 and membership.user_id = $2`,
    [projectId, session.user.id]
  );
  const role = membership.rows[0]?.role;
  if (role === undefined || !roleAtLeast(role, minimumRole)) return null;
  return { userId: session.user.id };
}

function roleAtLeast(role: "owner" | "admin" | "developer" | "viewer", minimum: "viewer" | "developer"): boolean {
  const ranks = { viewer: 0, developer: 1, admin: 2, owner: 3 } as const;
  return ranks[role] >= ranks[minimum];
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
