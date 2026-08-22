import assert from "node:assert/strict";
import test from "node:test";
import { dispatchOutbox, evaluateScenario } from "../src/worker.js";
import { validateScenarioDefinition } from "../src/scenario.js";

test("evaluates only matching latest scenario definitions", () => {
  const definition = {
    when: { "request.method": "POST" },
    assertions: [
      { path: "response.status", equals: 201 },
      { path: "response.id", exists: true }
    ]
  };
  assert.equal(evaluateScenario(definition, { request: { method: "GET" } }), null);
  assert.deepEqual(evaluateScenario(definition, { request: { method: "POST" }, response: { status: 201, id: "x" } }), {
    passed: true,
    assertions: [{ path: "response.status", passed: true }, { path: "response.id", passed: true }]
  });
  assert.equal(evaluateScenario(definition, { request: { method: "POST" }, response: { status: 500 } })?.passed, false);
});

test("rejects malformed scenario definitions as processing failures", () => {
  assert.throws(() => evaluateScenario({ assertions: [{ path: "bad path", exists: true }] }, {}), /invalid_scenario_definition/);
});

test("validates bounded scenario definitions at creation", () => {
  assert.doesNotThrow(() => validateScenarioDefinition({ assertions: [{ path: "response.status", equals: 200 }] }));
  assert.throws(() => validateScenarioDefinition({ assertions: [{ path: "response.status", equals: 200, exists: true }] }), /invalid_scenario_definition/);
  assert.throws(() => validateScenarioDefinition({ assertions: Array.from({ length: 101 }, () => ({ path: "response.status", exists: true })) }), /invalid_scenario_definition/);
});

test("publishes enough QStash deliveries to reach WORKER_MAX_ATTEMPTS", async () => {
  const publications: Array<Record<string, unknown>> = [];
  const event = {
    id: "5a8ad6ae-d872-4c9d-b3ea-5bfeacb93f17",
    payload: { schemaVersion: 1, eventId: "5a8ad6ae-d872-4c9d-b3ea-5bfeacb93f17", reportId: "8594f47f-9016-490d-ae9d-d6f158c1ffbb" },
    attempts: 1
  };
  const client = {
    async query(text: string) {
      if (text.includes("returning aggregate_id")) return { rows: [] };
      if (text.includes("returning event.id")) return { rows: [event] };
      return { rows: [] };
    }
  };
  const database = {
    primary: client,
    transaction: async (operation: (transactionClient: typeof client) => Promise<unknown>) => operation(client)
  };
  const queue = {
    client: { publishJSON: async (request: Record<string, unknown>) => { publications.push(request); } }
  };

  await dispatchOutbox(database as never, queue as never, "https://api.example.test/internal/jobs/process-report", 10, 5);

  assert.equal(publications.length, 1);
  assert.equal(publications[0]!.retries, 4);
});
