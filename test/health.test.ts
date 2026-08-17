import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server/createServer.js";
import { getDataPaths } from "../src/config/dataPaths.js";
import { closeServer } from "./serverTestUtils.js";

describe("health route", () => {
  let originalDataDir: string | undefined;

  beforeEach(() => {
    originalDataDir = process.env.GHOSTAPI_DATA_DIR;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.GHOSTAPI_DATA_DIR;
    else process.env.GHOSTAPI_DATA_DIR = originalDataDir;
  });

  it("reports ready with ok:true on a healthy local data directory", async () => {
    const app = await createServer({ host: "127.0.0.1", port: 8080, model: "gpt-4o-mini" });
    const server = app.listen(0);
    const address = server.address();

    if (address === null || typeof address === "string") {
      await closeServer(server);
      throw new Error("Expected TCP server address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      await expect(response.json()).resolves.toEqual({ ok: true, ready: true });
      expect(response.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("reports not ready with a 503 readiness status when a store is degraded", async () => {
    const paths = getDataPaths();
    await mkdir(join(paths.root, "reliability"), { recursive: true });
    await writeFile(paths.sloStore, "{ not json", "utf8");

    const app = await createServer({ host: "127.0.0.1", port: 8080, model: "gpt-4o-mini" });
    const server = app.listen(0);
    const address = server.address();

    if (address === null || typeof address === "string") {
      await closeServer(server);
      throw new Error("Expected TCP server address");
    }

    try {
      const health = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ ok: false, ready: false });

      const readiness = await fetch(`http://127.0.0.1:${address.port}/health/readiness`);
      expect(readiness.status).toBe(503);
      const report = await readiness.json();
      expect(report.ready).toBe(false);
      expect(report.stores.some((store: { id: string; status: string }) => store.id === "slo" && store.status === "degraded")).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
});