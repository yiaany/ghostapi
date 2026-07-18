import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type CacheEntry = {
  status: number;
  headers: Record<string, string | string[]>;
  body: unknown;
};

const BASE_CACHE_DIR = ".ghostapi/cache";

export async function initializeCacheDir(): Promise<void> {
  await mkdir(BASE_CACHE_DIR, { recursive: true });
}

export async function getCachedResponse(provider: string, hash: string): Promise<CacheEntry | null> {
  try {
    const filePath = join(BASE_CACHE_DIR, provider, `${hash}.json`);
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
  const providerDir = join(BASE_CACHE_DIR, provider);
  const filePath = join(providerDir, `${hash}.json`);
  const tempFilePath = join(providerDir, `${hash}.tmp.${randomUUID()}`);

  await mkdir(providerDir, { recursive: true });

  const content = JSON.stringify(entry, null, 2);
  
  await writeFile(tempFilePath, content, "utf8");
  await rename(tempFilePath, filePath);
}

export async function clearCache(): Promise<void> {
  await rm(BASE_CACHE_DIR, { recursive: true, force: true });
  await initializeCacheDir();
}