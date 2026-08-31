import { cors } from "@elysiajs/cors";
import { Elysia, t } from "elysia";
import { loadConfig, type HostedConfig } from "./config.js";
import { createAuth } from "./auth.js";
import { createDatabase, type Database } from "./db.js";
import {
  createIngestKey,
  revokeIngestKey,
  rotateIngestKey,
} from "./ingestKeys.js";
import {
  authenticateIngestKey,
  acceptReport,
  IdempotencyConflictError,
  markIngestKeyUsed,
  ReportAuthenticationError,
  ReportInputError,
  type ReportPayload,
} from "./reports.js";
import {
  createQueue,
  JobLeaseActiveError,
  processReportEvent,
  type ReportEvent,
} from "./worker.js";
import {
  createRateLimiter,
  RateLimitError,
  RateLimitUnavailableError,
} from "./rateLimit.js";
import {
  BoundedRequestBodyError,
  createBoundedRequest,
  installBoundedBodyReaders,
  readBoundedRequestBody,
} from "./boundedBody.js";
import {
  findOrganizationRole,
  findProjectRole,
  roleAtLeast,
  withAuthorizedMutation,
  type MemberRole,
} from "./access.js";
import {
  acceptInvitation,
  audit,
  createInvitation,
  createOrganization,
} from "./onboarding.js";
import { enforceQuota, TenantQuotaError } from "./quotas.js";
import {
  ScenarioDefinitionError,
  validateScenarioDefinition,
} from "./scenario.js";

const MAX_REPORT_BODY_BYTES = 512 * 1024;
const MAX_QUEUE_BODY_BYTES = 16 * 1024;
const MAX_GLOBAL_BODY_BYTES = 1024 * 1024;
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_SCENARIO_BODY_BYTES = 300 * 1024;

const reportBody = t.Object({
  schemaVersion: t.Literal(1),
  runId: t.String({ minLength: 1, maxLength: 128 }),
  payload: t.Record(t.String(), t.Unknown()),
});
const scenarioBody = t.Object({
  version: t.Integer({ minimum: 1, maximum: 100_000 }),
  definition: t.Record(t.String(), t.Unknown()),
});
const ingestKeyBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 80 }),
  expiresInDays: t.Integer({ minimum: 1, maximum: 90 }),
});
const organizationBody = t.Object({
  slug: t.String({ pattern: "^[a-z0-9][a-z0-9-]{1,62}$" }),
  name: t.String({ minLength: 1, maxLength: 120 }),
});
const projectBody = t.Object({
  slug: t.String({ pattern: "^[a-z0-9][a-z0-9-]{1,62}$" }),
  name: t.String({ minLength: 1, maxLength: 120 }),
});
const invitationBody = t.Object({
  email: t.String({ format: "email", maxLength: 320 }),
  role: t.Union([
    t.Literal("admin"),
    t.Literal("developer"),
    t.Literal("viewer"),
  ]),
  expiresInDays: t.Integer({ minimum: 1, maximum: 30 }),
});
const invitationAcceptanceBody = t.Object({
  token: t.String({ minLength: 32, maxLength: 128 }),
});
const memberRoleBody = t.Object({
  role: t.Union([
    t.Literal("owner"),
    t.Literal("admin"),
    t.Literal("developer"),
    t.Literal("viewer"),
  ]),
});

export type Dependencies = {
  database: Database;
  auth: ReturnType<typeof createAuth>;
  queue: ReturnType<typeof createQueue>;
  rateLimiter: ReturnType<typeof createRateLimiter>;
};

export function createHostedApp(
  config: HostedConfig,
  dependencies: Dependencies,
) {
  return new Elysia()
    .use(
      cors({
        origin: config.allowedOrigins,
        credentials: true,
        methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: [
          "authorization",
          "content-type",
          "idempotency-key",
          "x-ghostapi-ingest-key-id",
        ],
        maxAge: 600,
      }),
    )
    .onRequest(async ({ request, status }) => {
      const method = request.method.toUpperCase();
      const pathname = new URL(request.url).pathname;
      if (method === "POST" && pathname === "/v1/organizations") {
        try {
          await dependencies.rateLimiter.consume(
            `abuse:organization-create:ip:${await requestFingerprint(request)}`,
            config.organizationCreateLimitPerHour,
            60 * 60_000,
          );
        } catch (error) {
          if (error instanceof RateLimitError)
            return status(429, {
              error: "rate_limited",
              retryAfterSeconds: error.retryAfterSeconds,
            });
          if (error instanceof RateLimitUnavailableError)
            return status(503, { error: "rate_limit_unavailable" });
          throw error;
        }
      }
      if (
        !["POST", "PUT", "PATCH", "DELETE"].includes(method) ||
        request.body === null
      )
        return;
      const maxBytes = requestBodyLimit(
        pathname,
        request.headers.get("content-type"),
      );
      const declaredLength = request.headers.get("content-length");
      if (
        declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
      )
        return status(413, { error: "payload_too_large" });
      if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return;
      installBoundedBodyReaders(request, maxBytes);
    })
    .onBeforeHandle(({ request, status }) => {
      const method = request.method.toUpperCase();
      const pathname = new URL(request.url).pathname;
      if (
        !["POST", "PUT", "PATCH", "DELETE"].includes(method) ||
        pathname.includes("/reports") ||
        pathname.startsWith("/internal/")
      )
        return;
      const origin = request.headers.get("origin");
      if (origin === null || !config.allowedOrigins.includes(origin))
        return status(403, { error: "invalid_origin" });
    })
    .onAfterHandle(({ set }) => {
      set.headers["content-security-policy"] =
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
      set.headers["referrer-policy"] = "no-referrer";
      set.headers["x-content-type-options"] = "nosniff";
      set.headers["x-frame-options"] = "DENY";
      set.headers["permissions-policy"] =
        "camera=(), microphone=(), geolocation=()";
      set.headers["strict-transport-security"] =
        "max-age=31536000; includeSubDomains";
      set.headers["cache-control"] = "no-store";
    })
    .onError(({ error, status }) => {
      if (
        error instanceof BoundedRequestBodyError ||
        (error instanceof Error &&
          error.cause instanceof BoundedRequestBodyError)
      )
        return status(413, { error: "payload_too_large" });
      if (error instanceof ReportInputError)
        return status(422, { error: "invalid_report" });
      if (error instanceof ScenarioDefinitionError)
        return status(422, { error: "invalid_scenario_definition" });
      if (error instanceof TenantQuotaError)
        return status(429, {
          error: "tenant_quota_exceeded",
          resource: error.resource,
        });
      return undefined;
    })
    .all(
      "/api/auth",
      async ({ request }) =>
        dependencies.auth.handler(
          await createBoundedRequest(request, MAX_JSON_BODY_BYTES),
        ),
      { parse: "none" },
    )
    .all(
      "/api/auth/*",
      async ({ request }) =>
        dependencies.auth.handler(
          await createBoundedRequest(request, MAX_JSON_BODY_BYTES),
        ),
      { parse: "none" },
    )
    .get("/healthz", () => ({ status: "ok" }))
    .get("/readyz", async ({ status }) => {
      try {
        await Promise.all([
          dependencies.database.primary.query("select 1"),
          dependencies.database.auth.query("select 1"),
          dependencies.rateLimiter.ping(),
        ]);
        if (
          !dependencies.queue.configured ||
          new URL(config.qstashCallbackUrl).origin !==
            new URL(config.publicUrl).origin
        )
          throw new Error("dispatcher_configuration_invalid");
        return status(200, { status: "ready" });
      } catch {
        return status(503, { status: "not_ready" });
      }
    })
    .post(
      "/v1/organizations",
      async ({ body, request, status }) => {
        const session = await getSession(dependencies, request);
        if (session === null) return status(401, { error: "unauthorized" });
        try {
          const organization = await dependencies.database.transaction(
            (client) =>
              createOrganization(client, {
                userId: session.id,
                slug: body.slug,
                name: body.name,
              }),
          );
          return status(201, organization);
        } catch (error) {
          if (isUniqueViolation(error))
            return status(409, { error: "organization_slug_conflict" });
          throw error;
        }
      },
      { body: organizationBody },
    )
    .post(
      "/v1/organizations/:organizationId/projects",
      async ({ body, params, request, status }) => {
        const session = await getSession(dependencies, request);
        if (session === null) return status(404, { error: "not_found" });
        try {
          const result = await dependencies.database.transaction((client) =>
            withAuthorizedMutation(
              client,
              { organizationId: params.organizationId },
              session.id,
              "admin",
              async () => {
                await enforceQuota(client, params.organizationId, "projects");
                const project = await client.query<{
                  id: string;
                  slug: string;
                  name: string;
                }>(
                  "insert into app.projects (organization_id, slug, name) values ($1, $2, $3) returning id, slug, name",
                  [params.organizationId, body.slug, body.name],
                );
                await audit(
                  client,
                  params.organizationId,
                  session.id,
                  "project.created",
                  "project",
                  project.rows[0]!.id,
                );
                return project.rows[0]!;
              },
            ),
          );
          if (result === null) return status(404, { error: "not_found" });
          return status(201, result);
        } catch (error) {
          if (isUniqueViolation(error))
            return status(409, { error: "project_slug_conflict" });
          throw error;
        }
      },
      { body: projectBody },
    )
    .get(
      "/v1/organizations/:organizationId/members",
      async ({ params, request, status }) => {
        const member = await requireOrganizationMember(
          dependencies,
          request,
          params.organizationId,
          "admin",
        );
        if (member === null) return status(404, { error: "not_found" });
        const result = await dependencies.database.primary.query(
          "select user_id, role, created_at from app.organization_memberships where organization_id = $1 order by created_at",
          [params.organizationId],
        );
        return { members: result.rows };
      },
    )
    .patch(
      "/v1/organizations/:organizationId/members/:userId",
      async ({ body, params, request, status }) => {
        const session = await getSession(dependencies, request);
        if (session === null) return status(404, { error: "not_found" });
        const changed = await dependencies.database.transaction(
          async (client) => {
            return withAuthorizedMutation(
              client,
              { organizationId: params.organizationId },
              session.id,
              "admin",
              async ({ role }) => {
                const target = await client.query<{ role: MemberRole }>(
                  "select role from app.organization_memberships where organization_id = $1 and user_id = $2 for update",
                  [params.organizationId, params.userId],
                );
                const targetRole = target.rows[0]?.role;
                if (
                  targetRole === undefined ||
                  (role !== "owner" &&
                    (roleAtLeast(targetRole, "admin") ||
                      roleAtLeast(body.role, "admin")))
                )
                  return false;
                if (
                  targetRole === "owner" &&
                  body.role !== "owner" &&
                  (await ownerCount(client, params.organizationId)) <= 1
                )
                  return false;
                await client.query(
                  "update app.organization_memberships set role = $3 where organization_id = $1 and user_id = $2",
                  [params.organizationId, params.userId, body.role],
                );
                await audit(
                  client,
                  params.organizationId,
                  session.id,
                  "organization_member.role_changed",
                  "user",
                  params.userId,
                  { role: body.role },
                );
                return true;
              },
            );
          },
        );
        return changed
          ? { status: "updated" }
          : status(404, { error: "not_found" });
      },
      { body: memberRoleBody },
    )
    .delete(
      "/v1/organizations/:organizationId/members/:userId",
      async ({ params, request, status }) => {
        const session = await getSession(dependencies, request);
        if (session === null) return status(404, { error: "not_found" });
        const removed = await dependencies.database.transaction(
          async (client) => {
            return withAuthorizedMutation(
              client,
              { organizationId: params.organizationId },
              session.id,
              "admin",
              async ({ role }) => {
                const target = await client.query<{ role: MemberRole }>(
                  "select role from app.organization_memberships where organization_id = $1 and user_id = $2 for update",
                  [params.organizationId, params.userId],
                );
                const targetRole = target.rows[0]?.role;
                if (
                  targetRole === undefined ||
                  (role !== "owner" && roleAtLeast(targetRole, "admin")) ||
                  (targetRole === "owner" &&
                    (await ownerCount(client, params.organizationId)) <= 1)
                )
                  return false;
                await client.query(
                  "delete from app.organization_memberships where organization_id = $1 and user_id = $2",
                  [params.organizationId, params.userId],
                );
                await audit(
                  client,
                  params.organizationId,
                  session.id,
                  "organization_member.removed",
                  "user",
                  params.userId,
                );
                return true;
              },
            );
          },
        );
        return removed
          ? { status: "removed" }
          : status(404, { error: "not_found" });
      },
    )
    .post(
      "/v1/organizations/:organizationId/invitations",
      async ({ body, params, request, status }) => {
        const session = await getSession(dependencies, request);
        if (session === null) return status(404, { error: "not_found" });
        try {
          const invitation = await dependencies.database.transaction((client) =>
            withAuthorizedMutation(
              client,
              { organizationId: params.organizationId },
              session.id,
              "admin",
              ({ role }) => {
                if (role !== "owner" && body.role === "admin")
                  return Promise.resolve(null);
                return createInvitation(client, {
                  organizationId: params.organizationId,
                  actorId: session.id,
                  ...body,
                });
              },
            ),
          );
          if (invitation === null) return status(404, { error: "not_found" });
          return status(201, invitation);
        } catch (error) {
          if (isUniqueViolation(error))
            return status(409, { error: "active_invitation_exists" });
          throw error;
        }
      },
      { body: invitationBody },
    )
    .post(
      "/v1/invitations/accept",
      async ({ body, request, status }) => {
        const session = await getSession(dependencies, request);
        if (session === null || session.email === undefined)
          return status(401, { error: "unauthorized" });
        const accepted = await dependencies.database.transaction((client) =>
          acceptInvitation(client, {
            token: body.token,
            userId: session.id,
            userEmail: session.email!,
          }),
        );
        return accepted ?? status(404, { error: "not_found" });
      },
      { body: invitationAcceptanceBody },
    )
    .post(
      "/v1/projects/:projectId/reports",
      async ({ headers, params, request, status }) => {
        const keyId = headers["x-ghostapi-ingest-key-id"];
        const authorization = headers.authorization;
        const idempotencyKey = headers["idempotency-key"];
        try {
          await dependencies.rateLimiter.consume(
            `abuse:ip:${await requestFingerprint(request)}`,
            120,
            60_000,
          );
          if (keyId !== undefined)
            await dependencies.rateLimiter.consume(
              `abuse:key:${await hashRateLimitComponent(keyId)}`,
              90,
              60_000,
            );
        } catch (error) {
          if (error instanceof RateLimitError)
            return status(429, {
              error: "rate_limited",
              retryAfterSeconds: error.retryAfterSeconds,
            });
          if (error instanceof RateLimitUnavailableError)
            return status(503, { error: "rate_limit_unavailable" });
          throw error;
        }
        let body: ReportPayload;
        try {
          body = JSON.parse(
            await readBoundedRequestBody(request, MAX_REPORT_BODY_BYTES),
          ) as ReportPayload;
        } catch (error) {
          if (error instanceof BoundedRequestBodyError)
            return status(413, { error: "payload_too_large" });
          return status(422, { error: "invalid_report" });
        }
        if (
          keyId === undefined ||
          idempotencyKey === undefined ||
          authorization === undefined ||
          !authorization.startsWith("Bearer ")
        )
          return status(401, { error: "invalid_ingest_credentials" });
        try {
          const ingestKeyId = await authenticateIngestKey(
            dependencies.database.primary,
            params.projectId,
            keyId,
            authorization.slice("Bearer ".length),
          );
          await dependencies.rateLimiter.consume(
            `ci:${params.projectId}`,
            config.ciIngestLimitPerMinute,
            60_000,
          );
          const accepted = await dependencies.database.transaction(
            async (client) => {
              const result = await acceptReport(client, {
                projectId: params.projectId,
                ingestKeyId,
                idempotencyKey,
                report: body,
              });
              await markIngestKeyUsed(client, params.projectId, ingestKeyId);
              return result;
            },
          );
          return status(202, {
            reportId: accepted.reportId,
            status: accepted.status,
          });
        } catch (error) {
          if (error instanceof ReportAuthenticationError)
            return status(401, { error: "invalid_ingest_credentials" });
          if (error instanceof IdempotencyConflictError)
            return status(409, { error: "idempotency_conflict" });
          if (error instanceof ReportInputError)
            return status(422, { error: "invalid_report" });
          if (error instanceof RateLimitError)
            return status(429, {
              error: "rate_limited",
              retryAfterSeconds: error.retryAfterSeconds,
            });
          if (error instanceof RateLimitUnavailableError)
            return status(503, { error: "rate_limit_unavailable" });
          throw error;
        }
      },
      { parse: "none" },
    )
    .get("/v1/reports/:reportId", async ({ params, request, status, set }) => {
      const session = await getSession(dependencies, request);
      if (session === null) return status(404, { error: "not_found" });
      const result = await dependencies.database.primary.query(
        `select report.id, report.status, report.accepted_at, report.completed_at, report.failure_code,
                coalesce(jsonb_agg(jsonb_build_object('scenarioVersionId', result.scenario_version_id, 'status', result.status, 'result', result.result)) filter (where result.report_id is not null), '[]'::jsonb) as scenario_results
           from app.reports report
           join app.projects project on project.id = report.project_id
           join app.organization_memberships membership on membership.organization_id = project.organization_id and membership.user_id = $2
           left join app.scenario_run_results result on result.report_id = report.id
          where report.id = $1
          group by report.id`,
        [params.reportId, session.id],
      );
      const report = result.rows[0];
      if (report === undefined) return status(404, { error: "not_found" });
      set.headers["x-consistency"] = "primary";
      return report;
    })
    .get(
      "/v1/projects/:projectId/scenarios/:scenarioKey",
      async ({ params, query, request, set, status }) => {
        const member = await requireProjectMember(
          dependencies,
          request,
          params.projectId,
          "viewer",
        );
        if (member === null) return status(404, { error: "not_found" });
        const version =
          query.version === undefined ? null : Number(query.version);
        if (version !== null && (!Number.isInteger(version) || version < 1))
          return status(422, { error: "invalid_version" });
        const result = await dependencies.database.primary.query(
          `select id, version, definition, definition_sha256, created_at from app.scenario_versions
          where project_id = $1 and scenario_key = $2 and ($3::integer is null or version = $3) order by version desc limit 1`,
          [params.projectId, params.scenarioKey, version],
        );
        if (result.rows[0] === undefined)
          return status(404, { error: "not_found" });
        set.headers["x-consistency"] = "primary";
        return result.rows[0];
      },
    )
    .post(
      "/v1/projects/:projectId/scenarios/:scenarioKey",
      async ({ body, params, request, status }) => {
        const session = await getSession(dependencies, request);
        if (session === null) return status(404, { error: "not_found" });
        validateScenarioDefinition(body.definition);
        const definition = JSON.stringify(body.definition);
        if (Buffer.byteLength(definition, "utf8") > 256 * 1024)
          return status(413, { error: "definition_too_large" });
        const digest = Buffer.from(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(definition),
          ),
        ).toString("hex");
        try {
          const result = await dependencies.database.transaction((client) =>
            withAuthorizedMutation(
              client,
              { projectId: params.projectId },
              session.id,
              "developer",
              async ({ organizationId }) => {
                await enforceQuota(client, organizationId, "scenarios");
                return client.query(
                  `insert into app.scenario_versions (project_id, scenario_key, version, definition, definition_sha256, created_by)
             values ($1, $2, $3, $4::jsonb, $5, $6) returning id, version`,
                  [
                    params.projectId,
                    params.scenarioKey,
                    body.version,
                    definition,
                    digest,
                    session.id,
                  ],
                );
              },
            ),
          );
          if (result === null || result.rows[0] === undefined)
            return status(404, { error: "not_found" });
          return status(201, result.rows[0]!);
        } catch (error) {
          if (isUniqueViolation(error))
            return status(409, { error: "scenario_version_conflict" });
          throw error;
        }
      },
      { body: scenarioBody },
    )
    .get(
      "/v1/projects/:projectId/ingest-keys",
      async ({ params, request, status }) => {
        const member = await requireProjectMember(
          dependencies,
          request,
          params.projectId,
          "developer",
        );
        if (member === null) return status(404, { error: "not_found" });
        const result = await dependencies.database.primary.query(
          `select id, name, key_prefix, scopes, created_at, expires_at, revoked_at, last_used_at
           from app.ci_ingest_keys where project_id = $1 order by created_at desc`,
          [params.projectId],
        );
        return { keys: result.rows };
      },
    )
    .post(
      "/v1/projects/:projectId/ingest-keys",
      async ({ body, params, request, status }) => {
        const session = await getSession(dependencies, request);
        if (session === null) return status(404, { error: "not_found" });
        const key = await dependencies.database.transaction((client) =>
          withAuthorizedMutation(
            client,
            { projectId: params.projectId },
            session.id,
            "developer",
            () =>
              createIngestKey(client, {
                projectId: params.projectId,
                actorId: session.id,
                ...body,
              }),
          ),
        );
        if (key === null) return status(404, { error: "not_found" });
        return status(201, key);
      },
      { body: ingestKeyBody },
    )
    .post(
      "/v1/projects/:projectId/ingest-keys/:keyId/rotate",
      async ({ body, params, request, status }) => {
        const session = await getSession(dependencies, request);
        if (session === null) return status(404, { error: "not_found" });
        const key = await dependencies.database.transaction((client) =>
          withAuthorizedMutation(
            client,
            { projectId: params.projectId },
            session.id,
            "developer",
            () =>
              rotateIngestKey(client, {
                projectId: params.projectId,
                keyId: params.keyId,
                actorId: session.id,
                ...body,
              }),
          ),
        );
        return key === null
          ? status(404, { error: "not_found" })
          : status(201, key);
      },
      { body: ingestKeyBody },
    )
    .post(
      "/v1/projects/:projectId/ingest-keys/:keyId/revoke",
      async ({ params, request, status }) => {
        const session = await getSession(dependencies, request);
        if (session === null) return status(404, { error: "not_found" });
        const revoked = await dependencies.database.transaction((client) =>
          withAuthorizedMutation(
            client,
            { projectId: params.projectId },
            session.id,
            "developer",
            () =>
              revokeIngestKey(client, {
                projectId: params.projectId,
                keyId: params.keyId,
                actorId: session.id,
              }),
          ),
        );
        return revoked
          ? { status: "revoked" }
          : status(404, { error: "not_found" });
      },
    )
    .post(
      "/internal/jobs/process-report",
      async ({ request, status }) => {
        const signature = request.headers.get("upstash-signature");
        if (signature === null)
          return status(401, { error: "missing_queue_signature" });
        const rawBody = await readBoundedRequestBody(
          request,
          MAX_QUEUE_BODY_BYTES,
        );
        if (
          !(await dependencies.queue.receiver.verify({
            signature,
            body: rawBody,
            url: request.url,
          }))
        )
          return status(401, { error: "invalid_queue_signature" });
        let event: ReportEvent;
        try {
          event = JSON.parse(rawBody) as ReportEvent;
        } catch {
          return status(422, { error: "invalid_queue_event" });
        }
        try {
          return {
            status: await processReportEvent(
              dependencies.database,
              event,
              config.workerMaxAttempts,
            ),
          };
        } catch (error) {
          if (error instanceof JobLeaseActiveError)
            return status(503, { error: "worker_lease_active" });
          throw error;
        }
      },
      { parse: "none" },
    );
}

function requestBodyLimit(
  pathname: string,
  contentType: string | null,
): number {
  if (pathname.endsWith("/reports")) return MAX_REPORT_BODY_BYTES;
  if (pathname === "/internal/jobs/process-report") return MAX_QUEUE_BODY_BYTES;
  if (pathname.includes("/scenarios/")) return MAX_SCENARIO_BODY_BYTES;
  return contentType?.startsWith("application/json")
    ? MAX_JSON_BODY_BYTES
    : MAX_GLOBAL_BODY_BYTES;
}

async function requestFingerprint(request: Request): Promise<string> {
  const forwarded =
    request.headers.get("fly-client-ip") ??
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  return hashRateLimitComponent(forwarded);
}

async function hashRateLimitComponent(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex").slice(0, 32);
}

async function getSession(
  dependencies: Dependencies,
  request: Request,
): Promise<{ id: string; email?: string } | null> {
  const session = await dependencies.auth.api.getSession({
    headers: request.headers,
  });
  return session === null
    ? null
    : { id: session.user.id, email: session.user.email };
}

async function requireProjectMember(
  dependencies: Dependencies,
  request: Request,
  projectId: string,
  minimumRole: MemberRole,
) {
  const session = await getSession(dependencies, request);
  if (session === null) return null;
  const role = await findProjectRole(
    dependencies.database.primary,
    projectId,
    session.id,
  );
  return role !== null && roleAtLeast(role, minimumRole)
    ? { userId: session.id, role }
    : null;
}

async function requireOrganizationMember(
  dependencies: Dependencies,
  request: Request,
  organizationId: string,
  minimumRole: MemberRole,
) {
  const session = await getSession(dependencies, request);
  if (session === null) return null;
  const role = await findOrganizationRole(
    dependencies.database.primary,
    organizationId,
    session.id,
  );
  return role !== null && roleAtLeast(role, minimumRole)
    ? { userId: session.id, role }
    : null;
}

async function ownerCount(
  client: { query: Database["primary"]["query"] },
  organizationId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    "select count(*)::text as count from app.organization_memberships where organization_id = $1 and role = 'owner'",
    [organizationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

if (import.meta.main) {
  const config = loadConfig();
  const database = createDatabase(config);
  const server = createHostedApp(config, {
    database,
    auth: createAuth(config, database.auth),
    queue: createQueue(config),
    rateLimiter: createRateLimiter(config),
  }).listen({ port: config.port, hostname: "0.0.0.0" });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.stop();
    const timeout = setTimeout(() => process.exit(1), 10_000);
    await database.close();
    clearTimeout(timeout);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
