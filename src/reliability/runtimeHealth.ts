import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getDataDir, getDataPaths } from "../config/dataPaths.js";
import { ensurePrivateDirectory } from "../storage/fileStore.js";

const HEALTH_SCHEMA_VERSION = 1;
const HEALTH_KIND = "ghostapi.runtime-health";
const MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_KIND = "ghostapi.runtime-backup";
const MANIFEST_NAME = "manifest.json";
const MAX_CHECK_FILE_BYTES = 4 * 1024 * 1024;
const BACKUP_MAX_BYTES = 64 * 1024 * 1024;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

export type RuntimeDependencyStatus = "healthy" | "degraded" | "unavailable";
export type RuntimeStoreCheck = {
  id: string;
  kind: "file" | "dir";
  path: string;
  status: RuntimeDependencyStatus;
  detail?: string;
};
export type RuntimeHealthReport = {
  schemaVersion: 1;
  kind: "ghostapi.runtime-health";
  checkedAt: string;
  ready: boolean;
  dataDir: string;
  stores: RuntimeStoreCheck[];
};

export type BackupManifestEntry = { path: string; size: number; sha256: string };
export type BackupManifest = {
  schemaVersion: 1;
  kind: "ghostapi.runtime-backup";
  backupId: string;
  createdAt: string;
  sourceDataDir: string;
  fileCount: number;
  totalBytes: number;
  entries: BackupManifestEntry[];
  verified: boolean;
};
export type BackupResult = { backupId: string; path: string; fileCount: number; totalBytes: number; verified: true; createdAt: string };
export type RestoreResult = { restoredFileCount: number; verified: true; targetDir: string };

export class RuntimeHealthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeHealthError";
  }
}

export async function checkRuntimeHealth(options: { now?: () => Date } = {}): Promise<RuntimeHealthReport> {
  const now = options.now === undefined ? new Date() : options.now();
  const checkedAt = timestampValue(now, "Runtime health check time");
  const dataDir = getDataDir();
  let dataDirStatus: RuntimeDependencyStatus = "healthy";
  try {
    await ensurePrivateDirectory(dataDir);
  } catch (error) {
    dataDirStatus = "unavailable";
  }
  const stores = canonicalStores();
  const results: RuntimeStoreCheck[] = [];
  for (const store of stores) {
    let status: RuntimeDependencyStatus = "healthy";
    let detail: string | undefined;
    if (dataDirStatus !== "unavailable") {
      try {
        const info = await lstat(store.path).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
        if (info !== null) {
          if (info.isSymbolicLink()) throw new RuntimeHealthError(`${store.id} is a symbolic link.`);
          if (store.kind === "file") {
            if (!info.isFile()) throw new RuntimeHealthError(`${store.id} must be a regular file.`);
            const source = await readFile(store.path, "utf8");
            if (Buffer.byteLength(source, "utf8") > MAX_CHECK_FILE_BYTES) throw new RuntimeHealthError(`${store.id} exceeds its structural size limit.`);
            try {
              JSON.parse(source);
            } catch {
              throw new RuntimeHealthError(`${store.id} is not valid JSON.`);
            }
          } else if (!info.isDirectory()) {
            throw new RuntimeHealthError(`${store.id} must be a directory.`);
          }
        }
      } catch (error) {
        status = "degraded";
        detail = error instanceof Error ? error.message : "store check failed";
      }
    }
    results.push({ id: store.id, kind: store.kind, path: store.path, status, ...(detail === undefined ? {} : { detail }) });
  }
  if (dataDirStatus === "unavailable") {
    results.unshift({ id: "data-dir", kind: "dir", path: dataDir, status: "unavailable", detail: "data directory could not be created or is not a private non-symlink directory" });
  }
  const ready = dataDirStatus === "healthy" && results.every((store) => store.status === "healthy");
  return { schemaVersion: 1, kind: "ghostapi.runtime-health", checkedAt, ready, dataDir, stores: results };
}

export function formatRuntimeHealth(report: RuntimeHealthReport): string {
  const lines = [`Runtime health at ${report.checkedAt}: ${report.ready ? "ready" : "NOT READY"}`];
  for (const store of report.stores) {
    lines.push(`  ${store.id} [${store.kind}] ${store.status}${store.detail === undefined ? "" : ` - ${store.detail}`}`);
  }
  return lines.join("\n");
}

export async function backupRuntime(options: { destinationDir?: string; now?: () => Date } = {}): Promise<BackupResult> {
  const now = options.now === undefined ? new Date() : options.now();
  const createdAt = timestampValue(now, "Backup time");
  const sourceDir = getDataDir();
  const destinationDir = resolve(options.destinationDir ?? join(getDataPaths().backups, backupName(createdAt)));
  const existing = await lstat(destinationDir).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
  if (existing !== null) throw new RuntimeHealthError("Backup destination already exists; refusing to overwrite.");
  await ensurePrivateDirectory(destinationDir);

  const files = await collectBackupFiles(sourceDir, destinationDir);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > BACKUP_MAX_BYTES) {
    await rm(destinationDir, { recursive: true, force: true });
    throw new RuntimeHealthError(`Backup exceeds the ${BACKUP_MAX_BYTES} byte local limit.`);
  }

  const manifest: BackupManifest = {
    schemaVersion: 1,
    kind: "ghostapi.runtime-backup",
    backupId: `backup-${randomUUID().replace(/-/g, "").slice(0, 32)}`,
    createdAt,
    sourceDataDir: sourceDir,
    fileCount: files.length,
    totalBytes,
    entries: files.map((file) => ({ path: file.relativePath, size: file.size, sha256: file.sha256 })),
    verified: false
  };

  for (const file of files) {
    await copyFileWithHash(file.sourcePath, join(destinationDir, file.relativePath), file.size, file.sha256);
  }
  await atomicWriteBytes(join(destinationDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");

  await verifyBackupFiles(destinationDir, manifest);
  manifest.verified = true;
  await atomicWriteBytes(join(destinationDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");

  return { backupId: manifest.backupId, path: destinationDir, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, verified: true, createdAt };
}

export async function restoreRuntimeBackup(options: { sourceDir: string; targetDir: string }): Promise<RestoreResult> {
  const sourceDir = resolve(options.sourceDir);
  const targetDir = resolve(options.targetDir);
  const manifest = await readManifest(sourceDir);
  if (!manifest.verified) throw new RuntimeHealthError("Refusing to restore a backup that did not verify after creation.");
  if (targetDir === sourceDir || targetDir.startsWith(sourceDir + sep)) throw new RuntimeHealthError("Restore target must not be inside the backup source.");
  await ensurePrivateDirectory(targetDir);
  const existingTarget = await readdir(targetDir);
  if (existingTarget.length > 0) throw new RuntimeHealthError("Refusing to restore into a non-empty directory.");

  for (const entry of manifest.entries) {
    const relativePath = normalizeEntryPath(entry.path);
    const sourcePath = join(sourceDir, relativePath);
    const targetPath = join(targetDir, relativePath);
    assertContained(sourceDir, sourcePath);
    assertContained(targetDir, targetPath);
    await verifySourceEntry(sourcePath, entry);
    await copyFileWithHash(sourcePath, targetPath, entry.size, entry.sha256);
  }
  await verifyRestoredFiles(targetDir, manifest);
  return { restoredFileCount: manifest.fileCount, verified: true, targetDir };
}

function canonicalStores(): Array<{ id: string; kind: "file" | "dir"; path: string }> {
  const paths = getDataPaths();
  const files = [
    ["config", paths.config], ["state", paths.state], ["behaviors", paths.behaviors], ["approvals", paths.approvals],
    ["credential-broker", paths.credentialBroker], ["trust-ladder", paths.trustLadder], ["safety-controller", paths.safetyController],
    ["action-ledger", paths.actionLedger], ["team-control-plane", paths.teamControlPlane], ["fault-lab", paths.faultLab],
    ["product-telemetry", paths.productTelemetry], ["slo", paths.sloStore], ["reconciliation", paths.reconciliationStore], ["costs", paths.costStore],
    ["inventory", paths.inventoryStore]
  ] as const;
  const dirs = [
    ["cache", paths.cache], ["reports", paths.reports], ["scenarios", paths.scenarios], ["contracts", paths.contracts],
    ["worlds", paths.worlds], ["actions", paths.actions], ["incidents", paths.incidents], ["reliability", paths.reliability], ["backups", paths.backups]
  ] as const;
  return [
    ...files.map(([id, path]) => ({ id, kind: "file" as const, path })),
    ...dirs.map(([id, path]) => ({ id, kind: "dir" as const, path }))
  ];
}

async function collectBackupFiles(sourceDir: string, destinationDir: string): Promise<Array<{ relativePath: string; sourcePath: string; size: number; sha256: string }>> {
  const files: Array<{ relativePath: string; sourcePath: string; size: number; sha256: string }> = [];
  const skipRoots = new Set([resolve(getDataPaths().cache), resolve(getDataPaths().backups)]);
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const relativePath = relative(sourceDir, fullPath);
      if (entry.isDirectory()) {
        const relativeDirectory = relative(sourceDir, fullPath);
        if (fullPath === destinationDir || skipRoots.has(resolve(fullPath)) || relativeDirectory === "runs") continue;
        await walk(fullPath);
        continue;
      }
      if (entry.isSymbolicLink()) throw new RuntimeHealthError(`Refusing to back up a symbolic link: ${fullPath}`);
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".lock") || entry.name.endsWith(".tmp")) continue;
      const info = await lstat(fullPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new RuntimeHealthError(`Refusing to back up an unsafe file: ${fullPath}`);
      const content = await readFile(fullPath);
      files.push({ relativePath: relativePath.split(sep).join("/"), sourcePath: fullPath, size: content.byteLength, sha256: sha256Buffer(content) });
    }
  };
  await walk(sourceDir);
  return files;
}

async function copyFileWithHash(sourcePath: string, targetPath: string, expectedSize: number, expectedSha256: string): Promise<void> {
  await ensurePrivateDirectory(dirname(targetPath));
  const content = await readFile(sourcePath);
  if (content.byteLength !== expectedSize || sha256Buffer(content) !== expectedSha256) throw new RuntimeHealthError("Backup file content changed during copy; backup is not consistent.");
  await atomicWriteBytes(targetPath, content);
}

async function verifySourceEntry(sourcePath: string, entry: BackupManifestEntry): Promise<void> {
  const info = await lstat(sourcePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new RuntimeHealthError("Backup source entry is not a regular non-symlink file.");
  const content = await readFile(sourcePath);
  if (content.byteLength !== entry.size || sha256Buffer(content) !== entry.sha256) throw new RuntimeHealthError("Backup source entry failed integrity verification.");
  if (entry.path.endsWith(".json")) {
    try {
      JSON.parse(content.toString("utf8"));
    } catch {
      throw new RuntimeHealthError("Backup source entry is not valid JSON.");
    }
  }
}

async function verifyBackupFiles(destinationDir: string, manifest: BackupManifest): Promise<void> {
  for (const entry of manifest.entries) {
    const path = join(destinationDir, normalizeEntryPath(entry.path));
    assertContained(destinationDir, path);
    await verifySourceEntry(path, entry);
  }
  const manifestContent = await readFile(join(destinationDir, MANIFEST_NAME), "utf8");
  const parsed = validateManifest(JSON.parse(manifestContent));
  if (parsed.fileCount !== manifest.fileCount || parsed.totalBytes !== manifest.totalBytes) throw new RuntimeHealthError("Backup manifest does not match the copied files.");
}

async function verifyRestoredFiles(targetDir: string, manifest: BackupManifest): Promise<void> {
  for (const entry of manifest.entries) {
    const path = join(targetDir, normalizeEntryPath(entry.path));
    assertContained(targetDir, path);
    await verifySourceEntry(path, entry);
  }
}

async function readManifest(sourceDir: string): Promise<BackupManifest> {
  const source = await readFile(join(sourceDir, MANIFEST_NAME), "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new RuntimeHealthError("Backup manifest is not valid JSON.");
  }
  const manifest = validateManifest(value);
  for (const entry of manifest.entries) {
    const path = join(sourceDir, normalizeEntryPath(entry.path));
    assertContained(sourceDir, path);
  }
  return manifest;
}

async function atomicWriteBytes(targetPath: string, content: Buffer | string): Promise<void> {
  await ensurePrivateDirectory(dirname(targetPath));
  const tempPath = join(dirname(targetPath), `.${randomUUID().replace(/-/g, "")}.tmp`);
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, targetPath);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true });
    throw error;
  }
}

function validateManifest(value: unknown): BackupManifest {
  const manifest = object(value, "Backup manifest must be an object.");
  const expected = ["schemaVersion", "kind", "backupId", "createdAt", "sourceDataDir", "fileCount", "totalBytes", "entries", "verified"];
  for (const key of Object.keys(manifest)) if (!expected.includes(key)) throw new RuntimeHealthError(`Backup manifest contains unsupported field: ${key}`);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.kind !== MANIFEST_KIND) throw new RuntimeHealthError("Unsupported backup manifest schema.");
  if (typeof manifest.verified !== "boolean") throw new RuntimeHealthError("Backup manifest verified flag is invalid.");
  if (!Array.isArray(manifest.entries) || manifest.entries.length > 100_000) throw new RuntimeHealthError("Backup manifest entries are invalid.");
  const entries = manifest.entries.map((entry) => {
    const value = object(entry, "Backup manifest entry is invalid.");
    for (const key of Object.keys(value)) if (!["path", "size", "sha256"].includes(key)) throw new RuntimeHealthError(`Backup manifest entry contains unsupported field: ${key}`);
    const path = normalizeEntryPath(value.path);
    return { path, size: nonNegative(value.size, "Backup entry size", BACKUP_MAX_BYTES), sha256: hash(value.sha256, "Backup entry hash") };
  });
  return {
    schemaVersion: 1,
    kind: "ghostapi.runtime-backup",
    backupId: identifier(manifest.backupId, "Backup id"),
    createdAt: timestamp(manifest.createdAt, "Backup time"),
    sourceDataDir: text(manifest.sourceDataDir, "Backup source data directory", 4_000),
    fileCount: nonNegative(manifest.fileCount, "Backup file count", 100_000),
    totalBytes: nonNegative(manifest.totalBytes, "Backup total bytes", BACKUP_MAX_BYTES),
    entries,
    verified: manifest.verified
  };
}

function normalizeEntryPath(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4_000 || value.includes("..") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) throw new RuntimeHealthError("Backup manifest entry path is invalid.");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.includes("\u0000") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) throw new RuntimeHealthError("Backup manifest entry path is invalid.");
  return normalized;
}

function assertContained(root: string, candidate: string): void {
  const target = resolve(candidate);
  const rootResolved = resolve(root);
  const rel = relative(rootResolved, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new RuntimeHealthError("Backup or restore path escapes its root directory.");
}

function backupName(createdAt: string): string {
  return `backup-${createdAt.replace(/[-:.]/g, "").replace(/Z$/, "").toLowerCase()}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new RuntimeHealthError(`${label} must be a safe identifier.`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new RuntimeHealthError(`${label} must be a SHA-256 hash.`);
  return value;
}

function nonNegative(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new RuntimeHealthError(`${label} is invalid.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new RuntimeHealthError(`${label} must be an ISO UTC timestamp.`);
  return value;
}

function timestampValue(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new RuntimeHealthError(`${label} clock is invalid.`);
  return value.toISOString();
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max || /[\u0000-\u001f]/.test(value)) throw new RuntimeHealthError(`${label} is invalid.`);
  return value.trim();
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RuntimeHealthError(message);
  return value as Record<string, unknown>;
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}