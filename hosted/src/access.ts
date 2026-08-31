import type { Pool, PoolClient } from "pg";

export type MemberRole = "owner" | "admin" | "developer" | "viewer";

const ranks: Record<MemberRole, number> = {
  viewer: 0,
  developer: 1,
  admin: 2,
  owner: 3,
};

export function roleAtLeast(role: MemberRole, minimum: MemberRole): boolean {
  return ranks[role] >= ranks[minimum];
}

type MutationTarget = { organizationId: string } | { projectId: string };

export async function withAuthorizedMutation<T>(
  client: PoolClient,
  target: MutationTarget,
  userId: string,
  minimumRole: MemberRole,
  operation: (authorization: {
    organizationId: string;
    role: MemberRole;
  }) => Promise<T>,
): Promise<T | null> {
  let organizationId: string | undefined;
  if ("organizationId" in target) {
    const locked = await client.query<{ id: string }>(
      "select id from app.organizations where id = $1 for update",
      [target.organizationId],
    );
    organizationId = locked.rows[0]?.id;
  } else {
    const locked = await client.query<{ organization_id: string }>(
      `select project.organization_id
         from app.projects project
         join app.organizations organization on organization.id = project.organization_id
        where project.id = $1
        for update of organization`,
      [target.projectId],
    );
    organizationId = locked.rows[0]?.organization_id;
  }
  if (organizationId === undefined) return null;

  const membership = await client.query<{ role: MemberRole }>(
    "select role from app.organization_memberships where organization_id = $1 and user_id = $2",
    [organizationId, userId],
  );
  const role = membership.rows[0]?.role;
  if (role === undefined || !roleAtLeast(role, minimumRole)) return null;
  return operation({ organizationId, role });
}

export async function findProjectRole(
  database: Pool,
  projectId: string,
  userId: string,
): Promise<MemberRole | null> {
  const result = await database.query<{ role: MemberRole }>(
    `select membership.role
       from app.organization_memberships membership
       join app.projects project on project.organization_id = membership.organization_id
      where project.id = $1 and membership.user_id = $2`,
    [projectId, userId],
  );
  return result.rows[0]?.role ?? null;
}

export async function findOrganizationRole(
  database: Pool,
  organizationId: string,
  userId: string,
): Promise<MemberRole | null> {
  const result = await database.query<{ role: MemberRole }>(
    "select role from app.organization_memberships where organization_id = $1 and user_id = $2",
    [organizationId, userId],
  );
  return result.rows[0]?.role ?? null;
}
