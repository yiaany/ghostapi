-- Forward-only concurrency, quota, and worker hardening. Apply after 002.
alter type app.job_status add value if not exists 'dead_letter';

begin;

create table if not exists app.organization_quotas (
  organization_id uuid primary key references app.organizations(id) on delete cascade,
  projects integer not null default 50 check (projects between 1 and 10000),
  members integer not null default 100 check (members between 1 and 10000),
  invitations integer not null default 100 check (invitations between 1 and 10000),
  scenarios integer not null default 5000 check (scenarios between 1 and 1000000),
  keys integer not null default 20 check (keys between 1 and 10000),
  reports integer not null default 100000 check (reports between 1 and 10000000),
  updated_at timestamptz not null default now()
);

insert into app.organization_quotas (organization_id)
select id from app.organizations
on conflict (organization_id) do nothing;

create or replace function app.create_default_organization_quotas() returns trigger
language plpgsql security definer set search_path = pg_catalog, app as $$
begin
  insert into app.organization_quotas (organization_id) values (new.id)
  on conflict (organization_id) do nothing;
  return new;
end $$;

drop trigger if exists organizations_default_quotas on app.organizations;
create trigger organizations_default_quotas
after insert on app.organizations
for each row execute function app.create_default_organization_quotas();

alter table app.organization_quotas enable row level security;
drop policy if exists organization_quotas_service_policy on app.organization_quotas;
create policy organization_quotas_service_policy on app.organization_quotas
  for all to service_role using (true) with check (true);

create or replace function app.require_organization_owner() returns trigger
language plpgsql security definer set search_path = pg_catalog, app as $$
declare organization uuid := coalesce(new.organization_id, old.organization_id);
begin
  if exists (select 1 from app.organizations where id = organization)
     and not exists (select 1 from app.organization_memberships where organization_id = organization and role = 'owner') then
    raise exception 'organization must retain an owner' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists organization_owner_required on app.organization_memberships;
create constraint trigger organization_owner_required
after delete or update of role on app.organization_memberships
deferrable initially deferred
for each row execute function app.require_organization_owner();

do $$ begin
  alter table app.scenario_versions add constraint scenario_definition_object
    check (jsonb_typeof(definition) = 'object') not valid;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table app.scenario_versions add constraint scenario_definition_size
    check (octet_length(definition::text) <= 262144) not valid;
exception when duplicate_object then null;
end $$;

create index if not exists organization_memberships_owner_idx
  on app.organization_memberships (organization_id) where role = 'owner';

commit;
