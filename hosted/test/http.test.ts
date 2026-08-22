import assert from "node:assert/strict";
import test from "node:test";
import { createHostedApp, type Dependencies } from "../src/server.js";
import type { HostedConfig } from "../src/config.js";

const config: HostedConfig = {
  port: 3000,
  publicUrl: "https://api.example.test",
  allowedOrigins: ["https://app.example.test"],
  databaseUrl: "postgresql://primary",
  authDatabaseUrl: "postgresql://auth",
  betterAuthSecret: "x".repeat(32),
  googleClientId: "google",
  googleClientSecret: "secret",
  redisUrl: "https://redis.example.test",
  redisToken: "redis",
  ciIngestLimitPerMinute: 10,
  organizationCreateLimitPerHour: 10,
  qstashToken: "qstash",
  qstashCurrentSigningKey: "current",
  qstashNextSigningKey: "next",
  qstashCallbackUrl: "https://api.example.test/internal/jobs/process-report",
  outboxMaxAttempts: 10,
  workerMaxAttempts: 5,
  reportRetentionDays: 90,
  auditRetentionDays: 365
};

function dependencies(query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> = async () => ({ rows: [] })): Dependencies {
  const pool = { query };
  return {
    database: { primary: pool, reader: pool, auth: pool, transaction: async (operation: (client: never) => Promise<unknown>) => operation(pool as never), close: async () => undefined } as never,
    auth: {
      handler: async () => new Response("not found", { status: 404 }),
      api: { getSession: async ({ headers }: { headers: Headers }) => headers.get("authorization") === "Session member" ? { user: { id: "member", email: "member@example.test" } } : null }
    } as never,
    queue: { receiver: { verify: async () => true }, client: {}, configured: true } as never,
    rateLimiter: { consume: async () => undefined, ping: async () => undefined }
  } as Dependencies;
}

test("rejects a chunked oversized report before authentication or database access", async () => {
  let queries = 0;
  const app = createHostedApp(config, dependencies(async () => { queries += 1; return { rows: [] }; }));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(300 * 1024));
      controller.enqueue(new Uint8Array(300 * 1024));
      controller.close();
    }
  });
  const response = await app.handle(new Request("https://api.example.test/v1/projects/project/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half"
  } as RequestInit));
  assert.equal(response.status, 413);
  assert.equal(queries, 0);
});

test("returns tenant-safe not-found for unauthenticated and cross-tenant report reads", async () => {
  const calls: unknown[][] = [];
  const app = createHostedApp(config, dependencies(async (_text, values) => { calls.push(values ?? []); return { rows: [] }; }));
  const unauthenticated = await app.handle(new Request("https://api.example.test/v1/reports/report-a"));
  const crossTenant = await app.handle(new Request("https://api.example.test/v1/reports/report-a", { headers: { authorization: "Session member" } }));
  assert.equal(unauthenticated.status, 404);
  assert.equal(crossTenant.status, 404);
  assert.deepEqual(calls.at(-1), ["report-a", "member"]);
});

test("enforces CSRF origin and developer role on scenario writes", async () => {
  const app = createHostedApp(config, dependencies(async (text) => text.includes("organization_memberships") ? { rows: [{ role: "viewer" }] } : { rows: [] }));
  const body = JSON.stringify({ version: 1, definition: {} });
  const badOrigin = await app.handle(new Request("https://api.example.test/v1/projects/project/scenarios/test", { method: "POST", headers: { authorization: "Session member", "content-type": "application/json", origin: "https://evil.example" }, body }));
  const viewer = await app.handle(new Request("https://api.example.test/v1/projects/project/scenarios/test", { method: "POST", headers: { authorization: "Session member", "content-type": "application/json", origin: "https://app.example.test" }, body }));
  assert.equal(badOrigin.status, 403);
  assert.equal(viewer.status, 404);
});

test("rejects an oversized chunked schema route before JSON parsing", async () => {
  let queries = 0;
  const app = createHostedApp(config, dependencies(async () => { queries += 1; return { rows: [] }; }));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"version":1,"definition":{"value":"'));
      controller.enqueue(new TextEncoder().encode("x".repeat(310 * 1024)));
      controller.enqueue(new TextEncoder().encode('"}}'));
      controller.close();
    }
  });
  const response = await app.handle(new Request("https://api.example.test/v1/projects/project/scenarios/test", {
    method: "POST",
    headers: { authorization: "Session member", "content-type": "application/json", origin: "https://app.example.test" },
    body: stream,
    duplex: "half"
  } as RequestInit));
  assert.equal(response.status, 413);
  assert.equal(queries, 0);
});

test("sets security headers on health responses", async () => {
  const response = await createHostedApp(config, dependencies()).handle(new Request("https://api.example.test/healthz"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
});

test("passes a materialized bounded request to auth handlers that clone requests", async () => {
  const deps = dependencies();
  (deps.auth as unknown as { handler: (request: Request) => Promise<Response> }).handler = async (request) => Response.json(await request.clone().json());
  const response = await createHostedApp(config, deps).handle(new Request("https://api.example.test/api/auth/test", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.example.test" },
    body: JSON.stringify({ email: "member@example.test" })
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { email: "member@example.test" });
});

test("rejects oversized chunked auth bodies before a cloning auth handler", async () => {
  let handled = false;
  const deps = dependencies();
  (deps.auth as unknown as { handler: (request: Request) => Promise<Response> }).handler = async (request) => {
    handled = true;
    return Response.json(await request.clone().json());
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"email":"'));
      controller.enqueue(new TextEncoder().encode("x".repeat(70 * 1024)));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    }
  });
  const response = await createHostedApp(config, deps).handle(new Request("https://api.example.test/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.example.test" },
    body: stream,
    duplex: "half"
  } as RequestInit));
  assert.equal(response.status, 413);
  assert.equal(handled, false);
});

test("rate limits organization creation before authentication or database access", async () => {
  let sessions = 0;
  let queries = 0;
  const deps = dependencies(async () => { queries += 1; return { rows: [] }; });
  (deps.auth as unknown as { api: { getSession: () => Promise<null> } }).api.getSession = async () => { sessions += 1; return null; };
  deps.rateLimiter.consume = async () => { throw new (await import("../src/rateLimit.js")).RateLimitError(60); };
  const response = await createHostedApp(config, deps).handle(new Request("https://api.example.test/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.example.test" },
    body: JSON.stringify({ slug: "new-org", name: "New organization" })
  }));
  assert.equal(response.status, 429);
  assert.equal(sessions, 0);
  assert.equal(queries, 0);
});

test("returns tenant-safe not-found when a project mutation role was revoked", async () => {
  let inserted = false;
  const app = createHostedApp(config, dependencies(async (text) => {
    if (text.includes("from app.projects project")) return { rows: [{ organization_id: "org_123" }] };
    if (text.includes("select role from app.organization_memberships")) return { rows: [{ role: "viewer" }] };
    if (text.includes("insert into app.scenario_versions")) inserted = true;
    return { rows: [] };
  }));
  const response = await app.handle(new Request("https://api.example.test/v1/projects/project/scenarios/test", {
    method: "POST",
    headers: { authorization: "Session member", "content-type": "application/json", origin: "https://app.example.test" },
    body: JSON.stringify({ version: 1, definition: {} })
  }));
  assert.equal(response.status, 404);
  assert.equal(inserted, false);
});
