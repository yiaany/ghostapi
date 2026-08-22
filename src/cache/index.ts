import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";
import { sanitizeResponseHeaders } from "../security/headerSanitizer.js";

export const MAX_CACHE_ENTRIES = 100;
export const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRY_BYTES = 1024 * 1024;

export type CacheEntry = {
  status: number;
  headers: Record<string, string | string[]>;
  body: unknown;
};

export async function initializeCacheDir(): Promise<void> {
  await ensurePrivateDirectory(getDataPaths().cache);
}

export async function getCachedResponse(provider: string, hash: string): Promise<CacheEntry | null> {
  try {
    const filePath = cacheFilePath(provider, hash);
    const content = await readFile(filePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_CACHE_ENTRY_BYTES) throw new Error("Cache entry exceeds its size limit.");
    return validateCacheEntry(JSON.parse(content));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function setCachedResponse(provider: string, hash: string, entry: CacheEntry): Promise<void> {
  const filePath = cacheFilePath(provider, hash);
  const validated = validateCacheEntry(entry);
  if (Buffer.byteLength(JSON.stringify(validated), "utf8") > MAX_CACHE_ENTRY_BYTES) throw new Error("Cache entry exceeds its size limit.");
  const cacheRoot = getDataPaths().cache;
  await withFileLock(join(cacheRoot, ".quota"), async () => {
    await atomicWriteJson(filePath, validated);
    await enforceCacheQuota(cacheRoot);
  });
}

function validateCacheEntry(value: unknown): CacheEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Cache entry is invalid.");
  const entry = value as Record<string, unknown>;
  if (!Number.isInteger(entry.status) || typeof entry.status !== "number" || entry.status < 100 || entry.status > 599) throw new Error("Cache status is invalid.");
  const headers = sanitizeResponseHeaders(entry.headers);
  return { status: entry.status, headers, body: entry.body };
}

async function enforceCacheQuota(cacheRoot: string): Promise<void> {
  const providers = await readdir(cacheRoot, { withFileTypes: true });
  const entries = (await Promise.all(providers.filter((entry) => entry.isDirectory()).map(async (provider) => {
    const directory = join(cacheRoot, provider.name);
    const files = await readdir(directory, { withFileTypes: true });
    return Promise.all(files.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map(async (entry) => {
      const path = join(directory, entry.name);
      const info = await stat(path);
      return { path, size: info.size, mtimeMs: info.mtimeMs };
    }));
  }))).flat().sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  let bytes = entries.reduce((total, entry) => total + entry.size, 0);
  let count = entries.length;
  for (const entry of entries) {
    if (count <= MAX_CACHE_ENTRIES && bytes <= MAX_CACHE_BYTES) break;
    await rm(entry.path, { force: true });
    count -= 1;
    bytes -= entry.size;
  }
}

export async function clearCache(): Promise<void> {
  await rm(getDataPaths().cache, { recursive: true, force: true });
  await initializeCacheDir();
}

function cacheFilePath(provider: string, hash: string): string {
  if (!/^[a-z0-9_-]+$/i.test(provider) || !/^[a-z0-9_-]+$/i.test(hash)) {
    throw new Error("Cache provider and hash must contain only letters, numbers, underscores, or hyphens.");
  }
  return join(getDataPaths().cache, provider, `${hash}.json`);
}
