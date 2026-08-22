import type { PoolClient } from "pg";
import { sha256 } from "./crypto.js";
import type { MemberRole } from "./access.js";
import { enforceQuota, enforceUserOrganizationQuota, lockOrganization } from "./quotas.js";

export async function createOrganization(client: PoolClient, input: { userId: string; slug: string; name: string }) {
  await enforceUserOrganizationQuota(client, input.userId);
  const organization = await client.query<{ id: string; slug: string; name: string }>(
    "insert into app.organizations (slug, name, created_by) values ($1, $2, $3) returning id, slug, name",
    [input.slug, input.name, input.userId]
  );
  const record = organization.rows[0]!;
  await client.query("insert into app.organization_memberships (organization_id, user_id, role) values ($1, $2, 'owner')", [record.id, input.userId]);
  await audit(client, record.id, input.userId, "organization.created", "organization", record.id);
  return record;
}

export async function createInvitation(client: PoolClient, input: { organizationId: string; actorId: string; email: string; role: Exclude<MemberRole, "owner">; expiresInDays: number }) {
  if (!await lockOrganization(client, input.organizationId)) throw new Error("organization_not_found");
  await client.query(
    "update app.organization_invitations set revoked_at = now() where organization_id = $1 and lower(email) = lower($2) and accepted_at is null and revoked_at is null and expires_at <= now()",
    [input.organizationId, input.email]
  );
  await enforceQuota(client, input.organizationId, "invitations");
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const result = await client.query<{ id: string; expires_at: string | Date }>(
    `insert into app.organization_invitations (organization_id, email, role, token_sha256, invited_by, expires_at)
     values ($1, lower($2), $3, $4, $5, now() + ($6::integer * interval '1 day'))
     returning id, expires_at`,
    [input.organizationId, input.email, input.role, await sha256(token), input.actorId, input.expiresInDays]
  );
  const invitation = result.rows[0]!;
  await audit(client, input.organizationId, input.actorId, "organization_invitation.created", "organization_invitation", invitation.id, { role: input.role });
  return { id: invitation.id, token, expiresAt: new Date(invitation.expires_at).toISOString() };
}

export async function acceptInvitation(client: PoolClient, input: { token: string; userId: string; userEmail: string }) {
  const invitation = await client.query<{ id: string; organization_id: string; role: MemberRole; email: string }>(
    `select id, organization_id, role, email
       from app.organization_invitations
      where token_sha256 = $1 and accepted_at is null and revoked_at is null and expires_at > now()
      for update`,
    [await sha256(input.token)]
  );
  const record = invitation.rows[0];
  if (record === undefined || record.email.toLowerCase() !== input.userEmail.toLowerCase()) return null;
  await enforceQuota(client, record.organization_id, "members");
  await client.query(
    `insert into app.organization_memberships (organization_id, user_id, role) values ($1, $2, $3)
     on conflict (organization_id, user_id) do nothing`,
    [record.organization_id, input.userId, record.role]
  );
  await client.query("update app.organization_invitations set accepted_at = now(), accepted_by = $2 where id = $1", [record.id, input.userId]);
  await audit(client, record.organization_id, input.userId, "organization_invitation.accepted", "organization_invitation", record.id);
  return { organizationId: record.organization_id, role: record.role };
}

export async function audit(client: PoolClient, organizationId: string, actorId: string, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown> = {}) {
  await client.query(
    "insert into app.audit_events (organization_id, actor_id, action, resource_type, resource_id, metadata) values ($1, $2, $3, $4, $5, $6::jsonb)",
    [organizationId, actorId, action, resourceType, resourceId, JSON.stringify(metadata)]
  );
}
