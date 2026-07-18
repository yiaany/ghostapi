import type { NormalizedRequest } from "../../src/proxy/requestNormalizer.js";

export const stripeCustomerCreateBody = {
  email: "ada@example.com",
  name: "Ada Lovelace",
  metadata: { source: "test-fixture" }
};

export const genericTaskBody = {
  title: "Write integration tests",
  status: "open",
  priority: "high"
};

export const secretFixture = {
  authorization: `Bearer ${["sk", "live", "fixture", "secret"].join("_")}`,
  nested: {
    githubToken: ["ghp", "fixture", "secret"].join("_"),
    note: "visible"
  }
};

export function normalizedRequestFixture(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "POST",
    path: "/tasks",
    query: {},
    headers: { "content-type": "application/json" },
    body: genericTaskBody,
    receivedAt: "2026-07-14T00:00:00.000Z",
    ...overrides
  };
}
