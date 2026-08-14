import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDataPaths } from "../src/config/dataPaths.js";
import { ProductTelemetryError, readProductTelemetry, recordProductTelemetry, setProductTelemetryEnabled } from "../src/productTelemetry/index.js";

let tempDir: string | null = null;
let originalDataDir: string | undefined;

describe("local opt-in product telemetry", () => {
  beforeEach(async () => {
    originalDataDir = process.env.GHOSTAPI_DATA_DIR;
    tempDir = await mkdtemp(join(tmpdir(), "ghostapi-product-telemetry-"));
    process.env.GHOSTAPI_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.GHOSTAPI_DATA_DIR;
    else process.env.GHOSTAPI_DATA_DIR = originalDataDir;
    if (tempDir !== null) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("does not collect before explicit opt-in and records only aggregate counters after opt-in", async () => {
    await recordProductTelemetry("init_completed", new Date("2026-01-01T10:00:00.000Z"));
    expect(await readProductTelemetry()).toMatchObject({ enabled: false, counters: { init_completed: 0 }, activeWeeks: [] });

    await setProductTelemetryEnabled(true);
    await Promise.all(Array.from({ length: 25 }, () => recordProductTelemetry("evidence_generated", new Date("2026-01-01T10:00:00.000Z"))));
    await recordProductTelemetry("enforced_run_completed", new Date("2026-01-02T10:00:00.000Z"));

    expect(await readProductTelemetry()).toEqual({
      schemaVersion: 1,
      enabled: true,
      counters: { init_completed: 0, enforced_run_completed: 1, evidence_generated: 25, eval_completed: 0 },
      activeWeeks: ["2026-W01"],
      firstActivationAt: "2026-01-01T10:00:00.000Z",
      lastActivityAt: "2026-01-02T10:00:00.000Z"
    });
  });

  it("deletes local counters on opt-out and rejects malformed persisted state", async () => {
    await setProductTelemetryEnabled(true);
    await recordProductTelemetry("eval_completed", new Date("2026-02-01T10:00:00.000Z"));
    await setProductTelemetryEnabled(false);
    expect(await readProductTelemetry()).toMatchObject({ enabled: false, counters: { eval_completed: 0 } });

    await writeFile(getDataPaths().productTelemetry, JSON.stringify({ schemaVersion: 1, enabled: true, counters: {}, activeWeeks: [], secret: "not allowed" }), "utf8");
    await expect(readProductTelemetry()).rejects.toBeInstanceOf(ProductTelemetryError);
  });

  it("fails closed on clock rollback and counter overflow", async () => {
    await setProductTelemetryEnabled(true);
    await recordProductTelemetry("evidence_generated", new Date("2026-02-02T10:00:00.000Z"));
    await expect(recordProductTelemetry("init_completed", new Date("2026-02-01T10:00:00.000Z"))).rejects.toThrow("clock moved backwards");

    await writeFile(getDataPaths().productTelemetry, JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      counters: { init_completed: Number.MAX_SAFE_INTEGER, enforced_run_completed: 0, evidence_generated: 0, eval_completed: 0 },
      activeWeeks: []
    }), "utf8");
    await expect(recordProductTelemetry("init_completed", new Date("2026-02-03T10:00:00.000Z"))).rejects.toThrow("counter capacity reached");
  });
});
