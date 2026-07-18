import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearState, getStateStore, saveToStateStore } from "../src/state/stateStore.js";
import { extractIdFromPath, extractIdFromResponse } from "../src/state/stateExtractor.js";
import { resolveState } from "../src/state/stateResolver.js";
import type { NormalizedRequest } from "../src/proxy/requestNormalizer.js";

const STATE_FILE_PATH = join(".ghostapi", "state.json");

describe("State Management", () => {
  beforeEach(async () => {
    await clearState();
  });

  afterEach(async () => {
    await clearState();
  });

  describe("Store", () => {
    it("creates state.json if it does not exist", async () => {
      const state = await getStateStore();
      expect(state).toEqual({});
    });

    it("saves and retrieves objects", async () => {
      await saveToStateStore("stripe:cus_123", { id: "cus_123", email: "a@b.com" });
      const state = await getStateStore();
      
      expect(state["stripe:cus_123"]).toEqual({ id: "cus_123", email: "a@b.com" });
    });

    it("prevents race conditions via in-memory mutex", async () => {
      const promises = Array.from({ length: 50 }).map(async (_, index) => {
        await saveToStateStore(`test:obj_${index}`, { id: index });
      });

      await Promise.all(promises);

      const state = await getStateStore();
      expect(Object.keys(state).length).toBe(50);
      expect(state["test:obj_49"]).toEqual({ id: 49 });
    });
  });

  describe("Extractor", () => {
    it("extracts known ID fields from objects", () => {
      expect(extractIdFromResponse({ id: "cus_1" })).toBe("cus_1");
      expect(extractIdFromResponse({ sid: "AC1" })).toBe("AC1");
      expect(extractIdFromResponse({ uuid: "123-456" })).toBe("123-456");
      expect(extractIdFromResponse({ name: "hello" })).toBe("hello");
      expect(extractIdFromResponse({ number: 42 })).toBe("42");
    });

    it("returns undefined for missing or invalid IDs", () => {
      expect(extractIdFromResponse({ something_else: "abc" })).toBeUndefined();
      expect(extractIdFromResponse(null)).toBeUndefined();
      expect(extractIdFromResponse("string body")).toBeUndefined();
    });

    it("extracts ID from end of even-length paths", () => {
      expect(extractIdFromPath({ path: "/v1/customers/cus_1" } as NormalizedRequest)).toBe("cus_1");
      expect(extractIdFromPath({ path: "/emails/em_1" } as NormalizedRequest)).toBe("em_1");
    });

    it("returns undefined for odd-length paths (list endpoints)", () => {
      expect(extractIdFromPath({ path: "/v1/customers" } as NormalizedRequest)).toBeUndefined();
      expect(extractIdFromPath({ path: "/v1/customers/cus_1/charges" } as NormalizedRequest)).toBeUndefined();
    });
  });

  describe("Resolver", () => {
    it("resolves GET by ID from state", async () => {
      await saveToStateStore("stripe:cus_123", { id: "cus_123" });
      
      const req = { method: "GET", path: "/v1/customers/cus_123", query: {}, headers: {}, body: null, receivedAt: "" } as NormalizedRequest;
      const res = await resolveState(req, "stripe");

      expect(res?.status).toBe(200);
      expect(res?.body).toEqual({ id: "cus_123" });
    });

    it("resolves GET list formatting matching namespace", async () => {
      await saveToStateStore("stripe:cus_1", { id: "cus_1", object: "customer" });
      await saveToStateStore("stripe:cus_2", { id: "cus_2", object: "customer" });
      
      const req = { method: "GET", path: "/v1/customers", query: {}, headers: {}, body: null, receivedAt: "" } as NormalizedRequest;
      const res = await resolveState(req, "stripe");

      expect(res?.body).toEqual({
        object: "list",
        data: [{ id: "cus_1", object: "customer" }, { id: "cus_2", object: "customer" }],
        has_more: false,
        url: "/v1/list_placeholder"
      });
    });

    it("resolves DELETE by marking as deleted", async () => {
      await saveToStateStore("stripe:cus_1", { id: "cus_1", object: "customer" });
      
      const req = { method: "DELETE", path: "/v1/customers/cus_1", query: {}, headers: {}, body: null, receivedAt: "" } as NormalizedRequest;
      const res = await resolveState(req, "stripe");

      expect(res?.body).toEqual({ id: "cus_1", object: "customer", deleted: true });
      
      const state = await getStateStore();
      expect(state["stripe:cus_1"]).toMatchObject({ deleted: true });
    });

    it("formats OpenAI lists as object lists", async () => {
      await saveToStateStore("openai:model_mock_1", { id: "model_mock_1", object: "model" });

      const req = { method: "GET", path: "/v1/models", query: {}, headers: {}, body: null, receivedAt: "" } as NormalizedRequest;
      const res = await resolveState(req, "openai");

      expect(res?.body).toEqual({ object: "list", data: [{ id: "model_mock_1", object: "model" }] });
    });
  });
});
