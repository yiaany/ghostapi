import assert from "node:assert/strict";
import test from "node:test";
import { withAuthorizedMutation } from "../src/access.js";

test("locks the organization and re-reads the current role before mutation", async () => {
  const calls: string[] = [];
  const client = {
    async query(text: string) {
      calls.push(text);
      if (text.includes("select id from app.organizations"))
        return { rows: [{ id: "org_123" }] };
      if (text.includes("select role from app.organization_memberships"))
        return { rows: [{ role: "admin" }] };
      return { rows: [] };
    },
  };

  const result = await withAuthorizedMutation(
    client as never,
    { organizationId: "org_123" },
    "user_123",
    "admin",
    async () => {
      calls.push("mutation");
      return "created";
    },
  );

  assert.equal(result, "created");
  assert.match(calls[0]!, /organizations.*for update/i);
  assert.match(calls[1]!, /organization_memberships/i);
  assert.equal(calls[2], "mutation");
});

test("serializes project mutations on the organization and rejects a revoked role", async () => {
  const calls: string[] = [];
  const client = {
    async query(text: string) {
      calls.push(text);
      if (text.includes("from app.projects project"))
        return { rows: [{ organization_id: "org_123" }] };
      if (text.includes("select role from app.organization_memberships"))
        return { rows: [{ role: "viewer" }] };
      return { rows: [] };
    },
  };
  let mutated = false;

  const result = await withAuthorizedMutation(
    client as never,
    { projectId: "project_123" },
    "user_123",
    "developer",
    async () => {
      mutated = true;
      return true;
    },
  );

  assert.equal(result, null);
  assert.equal(mutated, false);
  assert.match(calls[0]!, /for update of organization/i);
  assert.match(calls[1]!, /organization_memberships/i);
});
