import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("forward hardening migration preserves owners and durable quotas", async () => {
  const migration = await readFile(
    new URL("../migrations/003_remaining_hardening.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    migration,
    /create constraint trigger organization_owner_required/i,
  );
  assert.match(migration, /deferrable initially deferred/i);
  assert.match(
    migration,
    /create table if not exists app\.organization_quotas/i,
  );
  assert.match(
    migration,
    /alter type app\.job_status add value if not exists 'dead_letter'/i,
  );
  assert.doesNotMatch(migration, /drop table|drop type|truncate/i);
});

test("organization creation quota migration is forward-only and durable", async () => {
  const migration = await readFile(
    new URL(
      "../migrations/004_organization_creation_quota.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /add column if not exists created_by text/i);
  assert.match(migration, /set created_by = \(/i);
  assert.match(
    migration,
    /create table if not exists app\.user_organization_quotas/i,
  );
  assert.match(migration, /organizations integer not null default 5/i);
  assert.match(migration, /enable row level security/i);
  assert.doesNotMatch(migration, /drop table|drop type|truncate/i);
});
