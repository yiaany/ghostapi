import { Client, Receiver } from "@upstash/qstash";
import type { Database } from "./db.js";
import type { HostedConfig } from "./config.js";

export type ReportEvent = { schemaVersion: 1; eventId: string; reportId: string };

export class JobLeaseActiveError extends Error {
  constructor() {
    super("Report worker lease is active.");
  }
}

export function createQueue(config: HostedConfig) {
  return {
    client: new Client({ token: config.qstashToken }),
    receiver: new Receiver({ currentSigningKey: config.qstashCurrentSigningKey, nextSigningKey: config.qstashNextSigningKey })
  };
}

export async function dispatchOutbox(database: Database, queue: ReturnType<typeof createQueue>, callbackUrl: string, limit = 100): Promise<number> {
  const events = await database.transaction(async (client) => {
    const claimed = await client.query<{ id: string; payload: ReportEvent }>(
      `with picked as (
         select id from app.outbox_events
          where dispatched_at is null and available_at <= now()
            and (status = 'pending' or lease_expires_at < now())
          order by created_at
          for update skip locked
          limit $1
       )
       update app.outbox_events event
          set status = 'leased', lease_expires_at = now() + interval '1 minute', attempts = attempts + 1
         from picked
        where event.id = picked.id
       returning event.id, event.payload`,
      [limit]
    );
    return claimed.rows;
  });

  for (const event of events) {
    try {
      await queue.client.publishJSON({
        url: callbackUrl,
        body: event.payload,
        retries: 5,
        deduplicationId: event.id,
        flowControl: { key: `report:${event.payload.reportId}`, parallelism: 1 }
      });
      await database.primary.query("update app.outbox_events set status = 'dispatched', dispatched_at = now(), lease_expires_at = null where id = $1", [event.id]);
    } catch {
      await database.primary.query("update app.outbox_events set status = 'pending', lease_expires_at = null where id = $1", [event.id]);
    }
  }
  return events.length;
}

export async function processReportEvent(database: Database, event: ReportEvent): Promise<"completed" | "duplicate"> {
  if (event.schemaVersion !== 1 || !isUuid(event.eventId) || !isUuid(event.reportId)) throw new Error("Invalid queue event.");
  return database.transaction(async (client) => {
    const outbox = await client.query<{ aggregate_id: string }>("select aggregate_id from app.outbox_events where id = $1 for update", [event.eventId]);
    if (outbox.rows[0]?.aggregate_id !== event.reportId) throw new Error("Queue event does not match its outbox aggregate.");

    const receipt = await client.query<{ event_id: string }>(
      `insert into app.job_receipts (event_id, handler, status, lease_expires_at)
       values ($1, 'process-report-v1', 'processing', now() + interval '5 minutes')
       on conflict (event_id, handler) do update
          set status = 'processing', lease_expires_at = now() + interval '5 minutes'
        where app.job_receipts.status = 'processing' and app.job_receipts.lease_expires_at < now()
       returning event_id`,
      [event.eventId]
    );
    if (receipt.rows[0] === undefined) {
      const existing = await client.query<{ status: "processing" | "completed"; lease_expires_at: string | null }>(
        "select status, lease_expires_at from app.job_receipts where event_id = $1 and handler = 'process-report-v1' for update",
        [event.eventId]
      );
      if (existing.rows[0]?.status === "completed") return "duplicate";
      throw new JobLeaseActiveError();
    }

    await client.query("update app.reports set status = 'processing' where id = $1 and status = 'accepted'", [event.reportId]);
    await client.query("update app.reports set status = 'completed', completed_at = now() where id = $1", [event.reportId]);
    await client.query("update app.job_receipts set status = 'completed', completed_at = now(), lease_expires_at = null where event_id = $1 and handler = 'process-report-v1'", [event.eventId]);
    return "completed";
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
