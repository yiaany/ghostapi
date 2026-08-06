import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { atomicWriteJson, ensurePrivateDirectory } from "../storage/fileStore.js";

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
    return JSON.parse(content) as CacheEntry;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function setCachedResponse(provider: string, hash: string, entry: CacheEntry): Promise<void> {
  const filePath = cacheFilePath(provider, hash);
  await atomicWriteJson(filePath, entry);
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
