import assert from "node:assert/strict";
import test from "node:test";
import { createIngestKey, revokeIngestKey } from "../src/ingestKeys.js";
import { sha256 } from "../src/crypto.js";

test("provisions an ingest key without persisting its plaintext secret", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (text.includes("insert into app.ci_ingest_keys")) {
        return { rows: [{ id: values![0], key_prefix: values![2], expires_at: "2026-09-07T00:00:00.000Z" }] };
      }
      return { rows: [] };
    }
  };

  const key = await createIngestKey(client as never, {
    projectId: "7b28ddf6-6e66-4d3e-94c3-f1736fa04bfc",
    actorId: "user_123",
    expiresInDays: 30
  });

  assert.match(key.id, /^[0-9a-f-]{36}$/);
  assert.match(key.keyPrefix, /^[a-z0-9]{12}$/);
  assert.match(key.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.values!.includes(key.secret), false);
  assert.equal(calls[0]!.values![3], await sha256(key.secret));
  assert.equal(calls[1]!.values![1], "user_123");
  assert.equal(calls[1]!.values![2], "ci_ingest_key.created");
});

test("revokes only a project-owned active ingest key and records the action", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (text.includes("update app.ci_ingest_keys")) return { rows: [{ id: values![0] }] };
      return { rows: [] };
    }
  };

  const revoked = await revokeIngestKey(client as never, {
    projectId: "7b28ddf6-6e66-4d3e-94c3-f1736fa04bfc",
    keyId: "a5d6e7f8-8b9c-4d3e-94c3-f1736fa04bfc",
    actorId: "user_123"
  });

  assert.equal(revoked, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.values![1], "7b28ddf6-6e66-4d3e-94c3-f1736fa04bfc");
  assert.equal(calls[1]!.values![2], "ci_ingest_key.revoked");
});

test("does not audit an already unavailable ingest key", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return { rows: [] };
    }
  };

  const revoked = await revokeIngestKey(client as never, {
    projectId: "7b28ddf6-6e66-4d3e-94c3-f1736fa04bfc",
    keyId: "a5d6e7f8-8b9c-4d3e-94c3-f1736fa04bfc",
    actorId: "user_123"
  });

  assert.equal(revoked, false);
  assert.equal(calls.length, 1);
});
