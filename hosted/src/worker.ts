import { Client, Receiver } from "@upstash/qstash";
import type { PoolClient } from "pg";
import type { Database } from "./db.js";
import type { HostedConfig } from "./config.js";
import { stableJson } from "./crypto.js";
import {
  isObject,
  ScenarioDefinitionError,
  validatePath,
  validateScenarioDefinition,
} from "./scenario.js";

export type ReportEvent = {
  schemaVersion: 1;
  eventId: string;
  reportId: string;
};

export class JobLeaseActiveError extends Error {
  constructor() {
    super("Report worker lease is active.");
  }
}

export function createQueue(config: HostedConfig) {
  return {
    client: new Client({ token: config.qstashToken }),
    receiver: new Receiver({
      currentSigningKey: config.qstashCurrentSigningKey,
      nextSigningKey: config.qstashNextSigningKey,
    }),
    configured: config.qstashCallbackUrl.startsWith("https://"),
  };
}

export async function dispatchOutbox(
  database: Database,
  queue: ReturnType<typeof createQueue>,
  callbackUrl: string,
  maxAttempts: number,
  workerMaxAttempts: number,
  limit = 100,
): Promise<number> {
  const events = await database.transaction(async (client) => {
    const exhausted = await client.query<{ aggregate_id: string }>(
      `update app.outbox_events
          set status = 'dead_letter', dead_lettered_at = now(), lease_expires_at = null,
              last_error = coalesce(last_error, 'dispatch_attempts_exhausted')
        where dispatched_at is null and status <> 'dead_letter' and attempts >= $1
        returning aggregate_id`,
      [maxAttempts],
    );
    if (exhausted.rows.length > 0) {
      await client.query(
        "update app.reports set status = 'failed', completed_at = now(), failure_code = 'dispatch_attempts_exhausted' where id = any($1::uuid[]) and status = 'accepted'",
        [exhausted.rows.map((row) => row.aggregate_id)],
      );
    }
    const claimed = await client.query<{
      id: string;
      payload: ReportEvent;
      attempts: number;
    }>(
      `with picked as (
         select id from app.outbox_events
          where dispatched_at is null and available_at <= now() and attempts < $2
            and (status = 'pending' or (status = 'leased' and lease_expires_at < now()))
          order by created_at
          for update skip locked
          limit $1
       )
       update app.outbox_events event
          set status = 'leased', lease_expires_at = now() + interval '1 minute', attempts = attempts + 1
         from picked
        where event.id = picked.id
       returning event.id, event.payload, event.attempts`,
      [limit, maxAttempts],
    );
    return claimed.rows;
  });

  for (const event of events) {
    try {
      await queue.client.publishJSON({
        url: callbackUrl,
        body: event.payload,
        retries: workerMaxAttempts - 1,
        deduplicationId: event.id,
        flowControl: {
          key: `report:${event.payload.reportId}`,
          parallelism: 1,
        },
      });
      await database.primary.query(
        "update app.outbox_events set status = 'dispatched', dispatched_at = now(), lease_expires_at = null, last_error = null where id = $1",
        [event.id],
      );
    } catch (error) {
      const exhausted = event.attempts >= maxAttempts;
      await database.primary.query(
        `update app.outbox_events
            set status = $2, lease_expires_at = null, last_error = $3,
                dead_lettered_at = case when $2 = 'dead_letter' then now() else null end,
                available_at = case when $2 = 'pending' then now() + (least(300, power(2, attempts)) * interval '1 second') else available_at end
          where id = $1`,
        [
          event.id,
          exhausted ? "dead_letter" : "pending",
          safeFailureCode(error),
        ],
      );
      if (exhausted) {
        await database.primary.query(
          "update app.reports set status = 'failed', completed_at = now(), failure_code = 'dispatch_attempts_exhausted' where id = $1 and status = 'accepted'",
          [event.payload.reportId],
        );
      }
    }
  }
  return events.length;
}

export async function processReportEvent(
  database: Database,
  event: ReportEvent,
  maxAttempts = 5,
): Promise<"completed" | "duplicate" | "dead_letter"> {
  if (
    event.schemaVersion !== 1 ||
    !isUuid(event.eventId) ||
    !isUuid(event.reportId)
  )
    throw new Error("Invalid queue event.");
  const claimed = await database.transaction(async (client) =>
    claimReport(client, event, maxAttempts),
  );
  if (claimed !== "claimed") return claimed;

  try {
    await database.transaction(async (client) => {
      const report = await client.query<{
        project_id: string;
        payload: Record<string, unknown>;
      }>(
        "select project_id, payload from app.reports where id = $1 and status = 'processing' for update",
        [event.reportId],
      );
      const record = report.rows[0];
      if (record === undefined) throw new Error("report_not_processable");
      const scenarios = await client.query<{ id: string; definition: unknown }>(
        `select distinct on (scenario_key) id, definition
           from app.scenario_versions
          where project_id = $1
          order by scenario_key, version desc`,
        [record.project_id],
      );
      for (const scenario of scenarios.rows) {
        let result: ReturnType<typeof evaluateScenario>;
        try {
          result = evaluateScenario(scenario.definition, record.payload);
        } catch (error) {
          if (!(error instanceof ScenarioDefinitionError)) throw error;
          await client.query(
            `insert into app.scenario_run_results (report_id, scenario_version_id, status, result)
             values ($1, $2, 'not-run', '{"error":"invalid_scenario_definition"}'::jsonb)
             on conflict (report_id, scenario_version_id) do update set status = excluded.status, result = excluded.result, completed_at = now()`,
            [event.reportId, scenario.id],
          );
          continue;
        }
        if (result === null) continue;
        await client.query(
          `insert into app.scenario_run_results (report_id, scenario_version_id, status, result)
           values ($1, $2, $3, $4::jsonb)
           on conflict (report_id, scenario_version_id) do update set status = excluded.status, result = excluded.result, completed_at = now()`,
          [
            event.reportId,
            scenario.id,
            result.passed ? "passed" : "failed",
            JSON.stringify(result),
          ],
        );
      }
      await client.query(
        "update app.reports set status = 'completed', completed_at = now(), failure_code = null where id = $1",
        [event.reportId],
      );
      await client.query(
        "update app.job_receipts set status = 'completed', completed_at = now(), lease_expires_at = null, failure_code = null where event_id = $1 and handler = 'process-report-v1'",
        [event.eventId],
      );
    });
    return "completed";
  } catch (error) {
    const failureCode = safeFailureCode(error);
    const attempts = await receiptAttempts(database, event.eventId);
    const deadLetter = !isRetryableFailure(error) || attempts >= maxAttempts;
    await database.transaction(async (client) => {
      await client.query(
        `update app.reports set status = $2, completed_at = case when $2 = 'failed' then now() else null end, failure_code = $3 where id = $1`,
        [event.reportId, deadLetter ? "failed" : "accepted", failureCode],
      );
      await client.query(
        `update app.job_receipts set status = $2, failed_at = now(), lease_expires_at = null, failure_code = $3
          where event_id = $1 and handler = 'process-report-v1'`,
        [event.eventId, deadLetter ? "dead_letter" : "failed", failureCode],
      );
    });
    if (deadLetter) return "dead_letter";
    throw error;
  }
}

async function claimReport(
  client: PoolClient,
  event: ReportEvent,
  maxAttempts: number,
): Promise<"claimed" | "duplicate" | "dead_letter"> {
  const outbox = await client.query<{ aggregate_id: string }>(
    "select aggregate_id from app.outbox_events where id = $1 for update",
    [event.eventId],
  );
  if (outbox.rows[0]?.aggregate_id !== event.reportId)
    throw new Error("queue_event_mismatch");
  const receipt = await client.query<{ event_id: string }>(
    `insert into app.job_receipts (event_id, handler, status, lease_expires_at, attempts)
     values ($1, 'process-report-v1', 'processing', now() + interval '5 minutes', 1)
     on conflict (event_id, handler) do update
        set status = 'processing', lease_expires_at = now() + interval '5 minutes', attempts = app.job_receipts.attempts + 1,
            failure_code = null, failed_at = null
       where ((app.job_receipts.status = 'processing' and app.job_receipts.lease_expires_at < now()) or app.job_receipts.status = 'failed')
         and app.job_receipts.attempts < $2
      returning event_id`,
    [event.eventId, maxAttempts],
  );
  if (receipt.rows[0] === undefined) {
    const existing = await client.query<{
      status: "processing" | "completed" | "failed" | "dead_letter";
      attempts: number;
    }>(
      "select status, attempts from app.job_receipts where event_id = $1 and handler = 'process-report-v1' for update",
      [event.eventId],
    );
    if (
      existing.rows[0]?.status === "completed" ||
      existing.rows[0]?.status === "dead_letter"
    )
      return "duplicate";
    if (
      existing.rows[0]?.status === "failed" &&
      existing.rows[0].attempts >= maxAttempts
    ) {
      await client.query(
        "update app.job_receipts set status = 'dead_letter', failed_at = now(), failure_code = coalesce(failure_code, 'worker_attempts_exhausted') where event_id = $1 and handler = 'process-report-v1'",
        [event.eventId],
      );
      await client.query(
        "update app.reports set status = 'failed', completed_at = now(), failure_code = 'worker_attempts_exhausted' where id = $1",
        [event.reportId],
      );
      return "dead_letter";
    }
    throw new JobLeaseActiveError();
  }
  await client.query(
    "update app.reports set status = 'processing', failure_code = null where id = $1 and status in ('accepted', 'failed')",
    [event.reportId],
  );
  return "claimed";
}

export function evaluateScenario(
  definition: unknown,
  payload: Record<string, unknown>,
): {
  passed: boolean;
  assertions: Array<{ path: string; passed: boolean }>;
} | null {
  validateScenarioDefinition(definition);
  const when = definition.when ?? {};
  for (const [path, expected] of Object.entries(when))
    if (!deepEqual(readPath(payload, path), expected)) return null;
  const assertions = definition.assertions ?? [];
  const results = assertions.map((assertion) => {
    const actual = readPath(payload, assertion.path);
    const passed =
      "equals" in assertion
        ? deepEqual(actual, assertion.equals)
        : assertion.exists === true
          ? actual !== undefined
          : false;
    return { path: assertion.path, passed };
  });
  return {
    passed: results.every((result) => result.passed),
    assertions: results,
  };
}

function readPath(value: unknown, path: string): unknown {
  validatePath(path);
  return path
    .split(".")
    .reduce<unknown>(
      (current, segment) => (isObject(current) ? current[segment] : undefined),
      value,
    );
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

async function receiptAttempts(
  database: Database,
  eventId: string,
): Promise<number> {
  const result = await database.primary.query<{ attempts: number }>(
    "select attempts from app.job_receipts where event_id = $1 and handler = 'process-report-v1'",
    [eventId],
  );
  return result.rows[0]?.attempts ?? 1;
}

function isRetryableFailure(error: unknown): boolean {
  if (error instanceof ScenarioDefinitionError) return false;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (["22P02", "23503", "23514"].includes(code)) return false;
  return (
    error instanceof Error &&
    !["queue_event_mismatch", "report_not_processable"].includes(error.message)
  );
}

function safeFailureCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "unknown_error";
  return /^[a-z0-9_:-]{1,120}$/i.test(value)
    ? value.toLowerCase()
    : "processing_error";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
