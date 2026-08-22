-- Forward-only per-user organization creation quotas. Apply after 003.
begin;

alter table app.organizations add column if not exists created_by text;

update app.organizations organization
   set created_by = (
    select membership.user_id
      from app.organization_memberships membership
     where membership.organization_id = organization.id and membership.role = 'owner'
     order by membership.created_at, membership.user_id
     limit 1
  )
 where organization.created_by is null
   and exists (
     select 1 from app.organization_memberships membership
      where membership.organization_id = organization.id and membership.role = 'owner'
   );

create index if not exists organizations_created_by_idx on app.organizations (created_by) where created_by is not null;

create table if not exists app.user_organization_quotas (
  user_id text primary key,
  organizations integer not null default 5 check (organizations between 1 and 1000),
  updated_at timestamptz not null default now()
);

alter table app.user_organization_quotas enable row level security;
drop policy if exists user_organization_quotas_service_policy on app.user_organization_quotas;
create policy user_organization_quotas_service_policy on app.user_organization_quotas
  for all to service_role using (true) with check (true);

commit;
