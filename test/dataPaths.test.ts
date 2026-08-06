import { describe, expect, it } from "vitest";
import { resolveDataPath } from "../src/config/dataPaths.js";
import { getCachedResponse } from "../src/cache/index.js";

describe("data path handling", () => {
  it("rejects attempts to escape the configured data root", () => {
    expect(() => resolveDataPath("..", "outside.json")).toThrow("must stay inside GHOSTAPI_DATA_DIR");
  });

  it("rejects path-like cache provider and hash values", async () => {
    await expect(getCachedResponse("../outside", "hash")).rejects.toThrow("Cache provider and hash");
    await expect(getCachedResponse("stripe", "../hash")).rejects.toThrow("Cache provider and hash");
  });
});
