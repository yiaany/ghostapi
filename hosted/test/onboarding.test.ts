import assert from "node:assert/strict";
import test from "node:test";
import { createInvitation, createOrganization } from "../src/onboarding.js";

test("revokes an expired invitation before inserting its transactional replacement", async () => {
  const calls: string[] = [];
  const client = {
    async query(text: string) {
      calls.push(text);
      if (text.includes("select id from app.organizations"))
        return { rows: [{ id: "org_123" }] };
      if (text.includes("organization_quotas"))
        return { rows: [{ count: 0, quota: 100 }] };
      if (text.includes("insert into app.organization_invitations"))
        return {
          rows: [{ id: "invite_123", expires_at: "2026-09-01T00:00:00.000Z" }],
        };
      return { rows: [] };
    },
  };

  const invitation = await createInvitation(client as never, {
    organizationId: "org_123",
    actorId: "owner_123",
    email: "member@example.test",
    role: "developer",
    expiresInDays: 7,
  });

  const revoke = calls.findIndex((text) =>
    text.includes("expires_at <= now()"),
  );
  const insert = calls.findIndex((text) =>
    text.includes("insert into app.organization_invitations"),
  );
  assert.ok(revoke >= 0 && insert > revoke);
  assert.equal(invitation.id, "invite_123");
});

test("locks a durable per-user quota before creating an organization", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (
        text.includes("select organizations from app.user_organization_quotas")
      )
        return { rows: [{ organizations: 5 }] };
      if (
        text.includes(
          "select count(*)::integer as count from app.organizations",
        )
      )
        return { rows: [{ count: 1 }] };
      if (text.includes("insert into app.organizations"))
        return { rows: [{ id: "org_123", slug: "example", name: "Example" }] };
      return { rows: [] };
    },
  };

  await createOrganization(client as never, {
    userId: "user_123",
    slug: "example",
    name: "Example",
  });

  const quotaRow = calls.findIndex((call) =>
    call.text.includes("insert into app.user_organization_quotas"),
  );
  const quotaLock = calls.findIndex(
    (call) =>
      call.text.includes(
        "select organizations from app.user_organization_quotas",
      ) && call.text.includes("for update"),
  );
  const usageCount = calls.findIndex((call) =>
    call.text.includes(
      "select count(*)::integer as count from app.organizations",
    ),
  );
  const organizationInsert = calls.findIndex((call) =>
    call.text.includes("insert into app.organizations"),
  );
  assert.ok(
    quotaRow >= 0 &&
      quotaLock > quotaRow &&
      usageCount > quotaLock &&
      organizationInsert > usageCount,
  );
  assert.deepEqual(calls[organizationInsert]!.values, [
    "example",
    "Example",
    "user_123",
  ]);
});
