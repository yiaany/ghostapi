-- Forward-only additions for hosted production hardening. Apply with the schema owner.
alter type app.outbox_status add value if not exists 'dead_letter';
alter type app.job_status add value if not exists 'failed';

begin;

alter table app.ci_ingest_keys
  add column if not exists name text,
  add column if not exists created_by text,
  add column if not exists last_used_at timestamptz;

update app.ci_ingest_keys set name = 'legacy-key' where name is null;
alter table app.ci_ingest_keys alter column name set not null;
do $$ begin
  alter table app.ci_ingest_keys add constraint ci_ingest_keys_name_length check (char_length(name) between 1 and 80) not valid;
exception when duplicate_object then null;
end $$;
alter table app.ci_ingest_keys validate constraint ci_ingest_keys_name_length;
create index if not exists ci_ingest_keys_project_created_idx on app.ci_ingest_keys (project_id, created_at desc);

alter table app.outbox_events
  add column if not exists last_error text,
  add column if not exists dead_lettered_at timestamptz;

alter table app.job_receipts
  add column if not exists attempts integer not null default 0,
  add column if not exists failure_code text,
  add column if not exists failed_at timestamptz;

alter table app.audit_events add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists app.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations(id) on delete cascade,
  email text not null check (char_length(email) between 3 and 320),
  role app.member_role not null check (role <> 'owner'),
  token_sha256 char(64) not null unique check (token_sha256 ~ '^[a-f0-9]{64}$'),
  invited_by text not null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);
create index if not exists organization_invitations_org_idx on app.organization_invitations (organization_id, created_at desc);
create unique index if not exists organization_invitations_active_email_idx
  on app.organization_invitations (organization_id, lower(email))
  where accepted_at is null and revoked_at is null;

alter table app.organization_invitations enable row level security;
drop policy if exists invitations_service_policy on app.organization_invitations;
create policy invitations_service_policy on app.organization_invitations
  for all to service_role using (true) with check (true);

create index if not exists reports_retention_idx on app.reports (completed_at) where status in ('completed', 'failed');
create index if not exists outbox_retention_idx on app.outbox_events (coalesce(dispatched_at, dead_lettered_at));
create index if not exists job_receipts_retention_idx on app.job_receipts (coalesce(completed_at, failed_at));

commit;
