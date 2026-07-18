import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCache, getCachedResponse, setCachedResponse } from "../src/cache/index.js";
import { createCacheKey } from "../src/proxy/cacheKey.js";

const TEST_DIR = ".ghostapi";

describe("Response Cache", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    await clearCache();
  });

  afterEach(async () => {
    await clearCache();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("API", () => {
    it("returns null for non-existent cache", async () => {
      expect(await getCachedResponse("stripe", "unknown")).toBeNull();
    });

    it("writes and reads a cache entry", async () => {
      const entry = {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { id: "test_123" }
      };

      await setCachedResponse("stripe", "hash123", entry);

      const cached = await getCachedResponse("stripe", "hash123");
      expect(cached).toEqual(entry);
    });

    it("creates file per entry in provider subdirectory", async () => {
      await setCachedResponse("github", "h1", { status: 200, headers: {}, body: {} });
      await setCachedResponse("github", "h2", { status: 200, headers: {}, body: {} });

      expect(existsSync(join(TEST_DIR, "cache", "github", "h1.json"))).toBe(true);
      expect(existsSync(join(TEST_DIR, "cache", "github", "h2.json"))).toBe(true);
    });
  });

  describe("Cache Key", () => {
    it("sorts array elements for stability", () => {
      const key1 = createCacheKey(
        { method: "GET", path: "/", query: {}, headers: {}, body: { items: [{ id: 1 }, { id: 2 }] }, receivedAt: "" },
        "generic"
      );

      const key2 = createCacheKey(
        { method: "GET", path: "/", query: {}, headers: {}, body: { items: [{ id: 2 }, { id: 1 }] }, receivedAt: "" },
        "generic"
      );

      expect(key1).toBe(key2);
    });

    it("includes specific headers in the key", () => {
      const key1 = createCacheKey(
        { method: "GET", path: "/", query: {}, headers: { "stripe-version": "2024" }, body: null, receivedAt: "" },
        "stripe"
      );

      const key2 = createCacheKey(
        { method: "GET", path: "/", query: {}, headers: { "stripe-version": "2023" }, body: null, receivedAt: "" },
        "stripe"
      );

      expect(key1).not.toBe(key2);
    });
    
    it("sorts query parameters for stability", () => {
      const key1 = createCacheKey(
        { method: "GET", path: "/", query: { z: "1", a: "2" }, headers: {}, body: null, receivedAt: "" },
        "generic"
      );

      const key2 = createCacheKey(
        { method: "GET", path: "/", query: { a: "2", z: "1" }, headers: {}, body: null, receivedAt: "" },
        "generic"
      );

      expect(key1).toBe(key2);
    });

    it("ignores receivedAt and non-important headers for stable repeatability", () => {
      const key1 = createCacheKey(
        { method: "POST", path: "/tasks", query: {}, headers: { authorization: "Bearer ***", "x-request-id": "one" }, body: { title: "A" }, receivedAt: "2026-01-01" },
        "generic"
      );

      const key2 = createCacheKey(
        { method: "POST", path: "/tasks", query: {}, headers: { authorization: "Bearer ***", "x-request-id": "two" }, body: { title: "A" }, receivedAt: "2026-02-02" },
        "generic"
      );

      expect(key1).toBe(key2);
    });
  });
});
