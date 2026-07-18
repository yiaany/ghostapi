import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addEvent, clearEventsHistoryForTests, getEventsHistory } from "../src/server/eventsStore.js";
import { addSseClient, broadcastEvent, getSseClientCount } from "../src/server/sse.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import EventEmitter from "node:events";

describe("Events Store", () => {
  beforeEach(async () => {
    clearEventsHistoryForTests();
  });

  afterEach(async () => {
    await rm(join(".ghostapi", "events.jsonl"), { force: true });
  });

  it("stores events and exposes history", async () => {
    const event = {
      id: "evt_1",
      timestamp: "2026-07-13",
      provider: "stripe",
      method: "POST",
      path: "/v1/charges",
      statusCode: 200,
      source: "fallback",
      durationMs: 42,
      request: {},
      response: {}
    } as const;

    await addEvent(event);
    expect(getEventsHistory()).toEqual([event]);
  });

  it("respects ring buffer max size of 200", async () => {
    for (let i = 0; i < 205; i++) {
        await addEvent({ id: `evt_${i}`, source: "fallback" } as any);
    }
    
    const history = getEventsHistory();
    expect(history.length).toBe(200);
    expect(history[0]?.id).toBe("evt_5");
    expect(history[199]?.id).toBe("evt_204");
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
    broadcastEvent({ id: "evt_dashboard", provider: "generic:rest-like", method: "POST", path: "/tasks", statusCode: 200, source: "ai", durationMs: 12, request: {}, response: {} } as any);

    const payload = written.find((entry) => entry.includes("proxy_event"));
    expect(payload).toBeDefined();
    expect(payload).toContain("data: ");
    expect(payload).toContain("evt_dashboard");
    expect(payload).toContain("generic:rest-like");

    mockResponse.emit("close");
  });
});
