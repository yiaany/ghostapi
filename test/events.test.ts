import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addEvent,
  clearEvents,
  clearEventsHistoryForTests,
  EVENT_LOG_ARCHIVES,
  getEventsHistory,
  MAX_EVENT_LOG_BYTES,
} from "../src/server/eventsStore.js";
import {
  addSseClient,
  broadcastEvent,
  getSseClientCount,
  MAX_SSE_CLIENTS,
} from "../src/server/sse.js";
import EventEmitter from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { getDataPaths } from "../src/config/dataPaths.js";

describe("Events Store", () => {
  beforeEach(async () => {
    clearEventsHistoryForTests();
  });

  afterEach(async () => {
    await clearEvents();
  });

  it("stores events and exposes history", async () => {
    const event = {
      id: randomUUID(),
      timestamp: "2026-07-13",
      provider: "stripe",
      method: "POST",
      path: "/v1/charges",
      statusCode: 200,
      source: "fallback",
      durationMs: 42,
      request: {},
      response: {},
    } as const;

    await addEvent(event);
    expect(getEventsHistory()).toEqual([event]);
  });

  it("respects ring buffer max size of 200", async () => {
    const ids = Array.from({ length: 205 }, () => randomUUID());
    for (let i = 0; i < 205; i++) {
      await addEvent({ id: ids[i], source: "fallback" } as any);
    }

    const history = getEventsHistory();
    expect(history.length).toBe(200);
    expect(history[0]?.id).toBe(ids[5]);
    expect(history[199]?.id).toBe(ids[204]);
  });

  it("redacts secrets before exposing or persisting events", async () => {
    const secret = ["sk", "live", "persisted-secret"].join("_");
    const safeEvent = await addEvent({
      id: randomUUID(),
      timestamp: "2026-08-05T00:00:00.000Z",
      provider: "stripe",
      method: "POST",
      path: "/v1/customers",
      statusCode: 200,
      source: "fallback",
      durationMs: 1,
      request: { authorization: `Bearer ${secret}` },
      response: { client_secret: secret },
    });

    const history = JSON.stringify(getEventsHistory());
    const persisted = await readFile(getDataPaths().events, "utf8");
    expect(JSON.stringify(safeEvent)).not.toContain(secret);
    expect(history).not.toContain(secret);
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("***");
  });

  it("rotates persisted logs at the documented byte limit", async () => {
    const payload = "x".repeat(200 * 1024);
    const eventCount =
      Math.ceil(MAX_EVENT_LOG_BYTES / Buffer.byteLength(payload)) + 2;
    for (let index = 0; index < eventCount; index += 1) {
      await addEvent({
        id: randomUUID(),
        timestamp: "2026-08-05T00:00:00.000Z",
        provider: "generic",
        method: "POST",
        path: "/large",
        statusCode: 200,
        source: "fallback",
        durationMs: 1,
        request: { payload },
        response: { index },
      });
    }

    expect((await stat(getDataPaths().events)).size).toBeLessThanOrEqual(
      MAX_EVENT_LOG_BYTES,
    );
    await expect(stat(`${getDataPaths().events}.1`)).resolves.toBeDefined();
    await expect(
      stat(`${getDataPaths().events}.${EVENT_LOG_ARCHIVES + 1}`),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("SSE Manager", () => {
  it("adds clients and broadcasts events", async () => {
    const written: string[] = [];
    const mockResponse = new EventEmitter();
    (mockResponse as any).write = (data: string) => written.push(data);

    addSseClient(mockResponse as any);
    expect(getSseClientCount()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 10)); // wait for initial string chunk

    broadcastEvent({ id: "evt_new", source: "ai" } as any);

    expect(written.length).toBe(2); // Initial connection message + broadcasted event
    expect(written[1]).toContain("evt_new");

    mockResponse.emit("close");
    expect(getSseClientCount()).toBe(0);
  });

  it("formats broadcast payloads as proxy_event SSE messages", () => {
    const written: string[] = [];
    const mockResponse = new EventEmitter();
    (mockResponse as any).write = (data: string) => written.push(data);

    addSseClient(mockResponse as any);
    broadcastEvent({
      id: "evt_dashboard",
      provider: "generic:rest-like",
      method: "POST",
      path: "/tasks",
      statusCode: 200,
      source: "ai",
      durationMs: 12,
      request: {},
      response: {},
    } as any);

    const payload = written.find((entry) => entry.includes("proxy_event"));
    expect(payload).toBeDefined();
    expect(payload).toContain("data: ");
    expect(payload).toContain("evt_dashboard");
    expect(payload).toContain("generic:rest-like");

    mockResponse.emit("close");
  });

  it("bounds clients and evicts a slow client on backpressure", async () => {
    const responses = Array.from({ length: MAX_SSE_CLIENTS }, () => {
      const response = new EventEmitter();
      (response as any).write = () => true;
      (response as any).end = vi.fn();
      return response;
    });
    for (const response of responses)
      expect(addSseClient(response as any)).toBe(true);
    const overflow = new EventEmitter();
    expect(addSseClient(overflow as any)).toBe(false);

    (responses[0] as any).write = () => false;
    broadcastEvent({ id: randomUUID(), source: "ai" } as any);
    expect((responses[0] as any).end).toHaveBeenCalled();
    expect(getSseClientCount()).toBe(MAX_SSE_CLIENTS - 1);

    for (const response of responses) response.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});
