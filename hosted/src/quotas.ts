import type { PoolClient } from "pg";

export type QuotaResource =
  | "organizations"
  | "projects"
  | "members"
  | "invitations"
  | "scenarios"
  | "keys"
  | "reports";

export class TenantQuotaError extends Error {
  constructor(readonly resource: QuotaResource) {
    super(`${resource}_quota_exceeded`);
  }
}

export async function lockOrganization(
  client: PoolClient,
  organizationId: string,
): Promise<boolean> {
  const result = await client.query(
    "select id from app.organizations where id = $1 for update",
    [organizationId],
  );
  return result.rows[0] !== undefined;
}

export async function organizationIdForProject(
  client: PoolClient,
  projectId: string,
): Promise<string | null> {
  const result = await client.query<{ organization_id: string }>(
    "select organization_id from app.projects where id = $1",
    [projectId],
  );
  return result.rows[0]?.organization_id ?? null;
}

export async function enforceQuota(
  client: PoolClient,
  organizationId: string,
  resource: QuotaResource,
): Promise<void> {
  if (resource === "organizations")
    throw new Error("Organization quotas are scoped to users.");
  if (!(await lockOrganization(client, organizationId)))
    throw new TenantQuotaError(resource);
  const queries: Record<Exclude<QuotaResource, "organizations">, string> = {
    projects:
      "select count(*)::integer as count from app.projects where organization_id = $1",
    members:
      "select count(*)::integer as count from app.organization_memberships where organization_id = $1",
    invitations:
      "select count(*)::integer as count from app.organization_invitations where organization_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()",
    scenarios:
      "select count(*)::integer as count from app.scenario_versions scenario join app.projects project on project.id = scenario.project_id where project.organization_id = $1",
    keys: "select count(*)::integer as count from app.ci_ingest_keys ingest_key join app.projects project on project.id = ingest_key.project_id where project.organization_id = $1 and ingest_key.revoked_at is null and ingest_key.expires_at > now()",
    reports:
      "select count(*)::integer as count from app.reports report join app.projects project on project.id = report.project_id where project.organization_id = $1",
  };
  const result = await client.query<{ count: number; quota: number }>(
    `select usage.count, quota.${resource} as quota
       from (${queries[resource]}) usage
       join app.organization_quotas quota on quota.organization_id = $1`,
    [organizationId],
  );
  const record = result.rows[0];
  if (record === undefined || record.count >= record.quota)
    throw new TenantQuotaError(resource);
}

export async function enforceUserOrganizationQuota(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    "insert into app.user_organization_quotas (user_id) values ($1) on conflict (user_id) do nothing",
    [userId],
  );
  const quotaResult = await client.query<{ organizations: number }>(
    "select organizations from app.user_organization_quotas where user_id = $1 for update",
    [userId],
  );
  const quota = quotaResult.rows[0]?.organizations;
  if (quota === undefined) throw new TenantQuotaError("organizations");

  const usageResult = await client.query<{ count: number }>(
    "select count(*)::integer as count from app.organizations where created_by = $1",
    [userId],
  );
  const count = usageResult.rows[0]?.count;
  if (count === undefined || count >= quota)
    throw new TenantQuotaError("organizations");
}
