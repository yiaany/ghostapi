import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

export async function runCleanup(
  database: ReturnType<typeof createDatabase>,
  config: ReturnType<typeof loadConfig>,
): Promise<Record<string, number>> {
  return database.transaction(async (client) => {
    const idempotency = await client.query(
      "delete from app.idempotency_ledger where expires_at < now()",
    );
    const reports = await client.query(
      `delete from app.reports report
        where status in ('completed', 'failed') and completed_at < now() - ($1::integer * interval '1 day')
          and not exists (select 1 from app.idempotency_ledger ledger where ledger.report_id = report.id)`,
      [config.reportRetentionDays],
    );
    const outbox = await client.query(
      "delete from app.outbox_events where coalesce(dispatched_at, dead_lettered_at) < now() - interval '30 days'",
    );
    const receipts = await client.query(
      "delete from app.job_receipts where coalesce(completed_at, failed_at) < now() - interval '30 days'",
    );
    const invitations = await client.query(
      "delete from app.organization_invitations where (expires_at < now() or revoked_at is not null or accepted_at is not null) and created_at < now() - interval '30 days'",
    );
    const audit = await client.query(
      "delete from app.audit_events where occurred_at < now() - ($1::integer * interval '1 day')",
      [config.auditRetentionDays],
    );
    return {
      reports: reports.rowCount ?? 0,
      idempotency: idempotency.rowCount ?? 0,
      outbox: outbox.rowCount ?? 0,
      receipts: receipts.rowCount ?? 0,
      invitations: invitations.rowCount ?? 0,
      audit: audit.rowCount ?? 0,
    };
  });
}

if (import.meta.main) {
  const config = loadConfig();
  const database = createDatabase(config);
  try {
    console.log(JSON.stringify(await runCleanup(database, config)));
  } finally {
    await database.close();
  }
}
