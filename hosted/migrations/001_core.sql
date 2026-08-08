begin;

create extension if not exists pgcrypto;
create schema if not exists app;
create schema if not exists auth;

create type app.member_role as enum ('owner', 'admin', 'developer', 'viewer');
create type app.report_status as enum ('accepted', 'processing', 'completed', 'failed');
create type app.outbox_status as enum ('pending', 'leased', 'dispatched');
create type app.job_status as enum ('processing', 'completed');

create table app.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table app.organization_memberships (
  organization_id uuid not null references app.organizations(id) on delete cascade,
  user_id text not null,
  role app.member_role not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table app.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table app.scenario_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references app.projects(id) on delete cascade,
  scenario_key text not null check (scenario_key ~ '^[a-z0-9][a-z0-9._-]{1,126}$'),
  version integer not null check (version > 0),
  definition jsonb not null,
  definition_sha256 char(64) not null check (definition_sha256 ~ '^[a-f0-9]{64}$'),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (project_id, scenario_key, version),
  unique (project_id, scenario_key, definition_sha256)
);
create index scenario_versions_read_idx on app.scenario_versions (project_id, scenario_key, version desc);

create table app.ci_ingest_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references app.projects(id) on delete cascade,
  key_prefix text not null unique check (key_prefix ~ '^[a-z0-9]{8,24}$'),
  secret_sha256 char(64) not null check (secret_sha256 ~ '^[a-f0-9]{64}$'),
  scopes text[] not null check (cardinality(scopes) > 0 and scopes <@ array['reports:write']::text[]),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index ci_ingest_keys_lookup_idx on app.ci_ingest_keys (id, project_id) where revoked_at is null;

create table app.reports (
  id uuid primary key,
  project_id uuid not null references app.projects(id) on delete cascade,
  ingest_key_id uuid not null references app.ci_ingest_keys(id),
  schema_version smallint not null check (schema_version = 1),
  run_id text not null check (char_length(run_id) between 1 and 128),
  payload_sha256 char(64) not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  status app.report_status not null default 'accepted',
  accepted_at timestamptz not null default now(),
  completed_at timestamptz,
  failure_code text,
  unique (project_id, run_id, payload_sha256)
);
create index reports_project_status_idx on app.reports (project_id, status, accepted_at desc);

create table app.idempotency_ledger (
  project_id uuid not null references app.projects(id) on delete cascade,
  key text not null check (char_length(key) between 1 and 256),
  request_sha256 char(64) not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  report_id uuid not null references app.reports(id) deferrable initially deferred,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (project_id, key),
  check (expires_at > created_at)
);
create index idempotency_ledger_expiry_idx on app.idempotency_ledger (expires_at);

create table app.outbox_events (
  id uuid primary key,
  event_type text not null check (event_type in ('report.accepted')),
  aggregate_id uuid not null references app.reports(id) on delete cascade,
  payload jsonb not null,
  status app.outbox_status not null default 'pending',
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  dispatched_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now()
);
create index outbox_dispatch_idx on app.outbox_events (status, available_at) where dispatched_at is null;

create table app.job_receipts (
  event_id uuid not null references app.outbox_events(id) on delete cascade,
  handler text not null check (handler = 'process-report-v1'),
  status app.job_status not null,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  primary key (event_id, handler)
);

create table app.scenario_run_results (
  report_id uuid not null references app.reports(id) on delete cascade,
  scenario_version_id uuid not null references app.scenario_versions(id),
  status text not null check (status in ('passed', 'failed', 'not-run')),
  result jsonb not null,
  completed_at timestamptz not null default now(),
  primary key (report_id, scenario_version_id)
);

create table app.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations(id) on delete cascade,
  actor_id text not null,
  action text not null,
  resource_type text not null,
  resource_id text not null,
  occurred_at timestamptz not null default now()
);
create index audit_events_org_time_idx on app.audit_events (organization_id, occurred_at desc);

alter table app.organizations enable row level security;
alter table app.organization_memberships enable row level security;
alter table app.projects enable row level security;
alter table app.scenario_versions enable row level security;
alter table app.ci_ingest_keys enable row level security;
alter table app.reports enable row level security;
alter table app.idempotency_ledger enable row level security;
alter table app.outbox_events enable row level security;
alter table app.job_receipts enable row level security;
alter table app.scenario_run_results enable row level security;
alter table app.audit_events enable row level security;

create policy organizations_service_policy on app.organizations
  for all to service_role using (true) with check (true);
create policy memberships_service_policy on app.organization_memberships
  for all to service_role using (true) with check (true);
create policy projects_service_policy on app.projects
  for all to service_role using (true) with check (true);
create policy scenarios_service_policy on app.scenario_versions
  for all to service_role using (true) with check (true);
create policy ingest_keys_service_policy on app.ci_ingest_keys
  for all to service_role using (true) with check (true);
create policy reports_service_policy on app.reports
  for all to service_role using (true) with check (true);
create policy idempotency_service_policy on app.idempotency_ledger
  for all to service_role using (true) with check (true);
create policy outbox_service_policy on app.outbox_events
  for all to service_role using (true) with check (true);
create policy receipts_service_policy on app.job_receipts
  for all to service_role using (true) with check (true);
create policy scenario_results_service_policy on app.scenario_run_results
  for all to service_role using (true) with check (true);
create policy audit_events_service_policy on app.audit_events
  for all to service_role using (true) with check (true);

commit;
