import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorldPath } from "../src/worlds/index.js";
import { createWorld, inspectWorld } from "../src/worlds/index.js";
import { createLocalActionLedger, createTestLedgerAccessAuthorizer } from "../src/ledger/index.js";
import { backupRuntime, checkRuntimeHealth, restoreRuntimeBackup } from "../src/reliability/index.js";

const FIXED_NOW = "2029-01-01T00:00:00.000Z";

describe("runtime health and backup/restore", () => {
  let originalDataDir: string | undefined;

  beforeEach(() => {
    originalDataDir = process.env.GHOSTAPI_DATA_DIR;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.GHOSTAPI_DATA_DIR;
    else process.env.GHOSTAPI_DATA_DIR = originalDataDir;
  });

  it("reports ready on a fresh data directory and degraded on a corrupt store", async () => {
    const healthy = await checkRuntimeHealth();
    expect(healthy.ready).toBe(true);
    expect(healthy.stores.every((store) => store.status === "healthy")).toBe(true);

    const root = process.env.GHOSTAPI_DATA_DIR!;
    await mkdir(join(root, "reliability"), { recursive: true });
    await writeFile(join(root, "reliability", "costs.json"), "{ broken", "utf8");
    const degraded = await checkRuntimeHealth();
    expect(degraded.ready).toBe(false);
    expect(degraded.stores.find((store) => store.id === "costs")?.status).toBe("degraded");
    await rm(join(root, "reliability", "costs.json"), { force: true });
  });

  it("backs up and restores a populated runtime for a disaster-recovery drill", async () => {
    const root = process.env.GHOSTAPI_DATA_DIR!;
    await createWorld({ id: "dr-world", seed: "dr-seed" });
    const access = createTestLedgerAccessAuthorizer();
    const capability = access.issue({ tenantId: "dr-tenant", principalId: "auditor", permissions: ["append", "read", "export", "manage_retention"] });
    const ledger = createLocalActionLedger({ path: join(root, "action-ledger.json"), now: () => new Date(FIXED_NOW), accessAuthorizer: access.authorizer });
    await ledger.configureRetention(capability, 30);

    const backup = await backupRuntime({ destinationDir: join(root, "reliability", "backups", "dr-backup") });
    expect(backup.verified).toBe(true);
    expect(backup.fileCount).toBeGreaterThan(0);

    await rm(join(root, "worlds", "dr-world.world.json"), { force: true });
    await expect(inspectWorld("dr-world")).rejects.toThrow("was not found");

    const restoredDir = join(root, "reliability", "backups", "dr-restored");
    await restoreRuntimeBackup({ sourceDir: backup.path, targetDir: restoredDir });
    process.env.GHOSTAPI_DATA_DIR = restoredDir;

    const world = await inspectWorld("dr-world");
    expect(world.manifest.id).toBe("dr-world");
    const restoredAccess = createTestLedgerAccessAuthorizer();
    const restoredCapability = restoredAccess.issue({ tenantId: "dr-tenant", principalId: "auditor", permissions: ["append", "read"] });
    const restoredLedger = createLocalActionLedger({ now: () => new Date(FIXED_NOW), accessAuthorizer: restoredAccess.authorizer });
    expect(await restoredLedger.verifyTenant(restoredCapability)).toMatchObject({ valid: true });
  });

  it("refuses to overwrite an existing backup destination", async () => {
    const root = process.env.GHOSTAPI_DATA_DIR!;
    await createWorld({ id: "dr-world-two", seed: "dr-seed-two" });
    await backupRuntime({ destinationDir: join(root, "reliability", "backups", "dr-backup-two") });
    await expect(backupRuntime({ destinationDir: join(root, "reliability", "backups", "dr-backup-two") })).rejects.toThrow("already exists");
  });

  it("rejects a tampered backup during restore", async () => {
    const root = process.env.GHOSTAPI_DATA_DIR!;
    await createWorld({ id: "dr-world-three", seed: "dr-seed-three" });
    const backup = await backupRuntime({ destinationDir: join(root, "reliability", "backups", "dr-backup-three") });
    const worldPath = join(backup.path, "worlds", "dr-world-three.world.json");
    await writeFile(worldPath, "tampered", "utf8");
    await expect(restoreRuntimeBackup({ sourceDir: backup.path, targetDir: join(root, "reliability", "backups", "dr-restored-three") })).rejects.toThrow("integrity verification");
  });

  it("rejects a restore manifest that escapes the backup root", async () => {
    const root = process.env.GHOSTAPI_DATA_DIR!;
    await createWorld({ id: "dr-world-four", seed: "dr-seed-four" });
    const backup = await backupRuntime({ destinationDir: join(root, "reliability", "backups", "dr-backup-four") });
    const manifest = JSON.parse(await readFile(join(backup.path, "manifest.json"), "utf8")) as { entries: Array<{ path: string }> };
    manifest.entries.push({ path: "../escape.json", size: 1, sha256: "a".repeat(64) });
    await writeFile(join(backup.path, "manifest.json"), JSON.stringify(manifest), "utf8");
    await expect(restoreRuntimeBackup({ sourceDir: backup.path, targetDir: join(root, "reliability", "backups", "dr-restored-four") })).rejects.toThrow("invalid");
  });

  it("reports degraded when the inventory store is corrupt", async () => {
    const root = process.env.GHOSTAPI_DATA_DIR!;
    await writeFile(join(root, "inventory.json"), "{ broken", "utf8");
    const degraded = await checkRuntimeHealth();
    expect(degraded.ready).toBe(false);
    expect(degraded.stores.find((store) => store.id === "inventory")?.status).toBe("degraded");
    await rm(join(root, "inventory.json"), { force: true });
  });

  it("refuses to restore into a non-empty target directory", async () => {
    const root = process.env.GHOSTAPI_DATA_DIR!;
    await createWorld({ id: "dr-world-six", seed: "dr-seed-six" });
    const backup = await backupRuntime({ destinationDir: join(root, "reliability", "backups", "dr-backup-six") });
    const occupied = join(root, "reliability", "backups", "dr-restored-occupied");
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, "existing.json"), "{}", "utf8");
    await expect(restoreRuntimeBackup({ sourceDir: backup.path, targetDir: occupied })).rejects.toThrow("non-empty directory");
  });

  it("excludes only the canonical cache, runs, and backups locations", async () => {
    const root = process.env.GHOSTAPI_DATA_DIR!;
    await mkdir(join(root, "cache"), { recursive: true });
    await mkdir(join(root, "runs"), { recursive: true });
    await mkdir(join(root, "contracts", "sub", "cache"), { recursive: true });
    await writeFile(join(root, "cache", "drop.txt"), "drop", "utf8");
    await writeFile(join(root, "runs", "drop.txt"), "drop", "utf8");
    await writeFile(join(root, "contracts", "sub", "cache", "keep.txt"), "keep", "utf8");
    const backup = await backupRuntime({ destinationDir: join(root, "reliability", "backups", "dr-backup-exclusions") });
    const manifest = JSON.parse(await readFile(join(backup.path, "manifest.json"), "utf8")) as { entries: Array<{ path: string }> };
    const paths = manifest.entries.map((entry) => entry.path);
    expect(paths).toContain("contracts/sub/cache/keep.txt");
    expect(paths).not.toContain("cache/drop.txt");
    expect(paths).not.toContain("runs/drop.txt");
    expect(paths.every((path) => !path.startsWith("reliability/backups/"))).toBe(true);
  });

  it("verifies the backup left the source data directory untouched", async () => {
    const root = process.env.GHOSTAPI_DATA_DIR!;
    await createWorld({ id: "dr-world-five", seed: "dr-seed-five" });
    const before = await readFile(getWorldPath("dr-world-five"));
    await backupRuntime({ destinationDir: join(root, "reliability", "backups", "dr-backup-five") });
    const after = await readFile(getWorldPath("dr-world-five"));
    expect(after).toEqual(before);
  });
});
