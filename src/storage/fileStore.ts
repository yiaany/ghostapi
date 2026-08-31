import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 20;

type FileStoreOptions = {
  lockTimeoutMs?: number;
  staleLockMs?: number;
};

export async function ensurePrivateDirectory(
  directoryPath: string,
): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const info = await lstat(directoryPath);
  if (info.isSymbolicLink()) {
    throw new Error(
      `Refusing to use symbolic-link data directory: ${directoryPath}`,
    );
  }
  if (process.platform !== "win32") await chmod(directoryPath, 0o700);
}

export async function readJsonFile<T>(
  filePath: string,
  fallback: T,
  sanitize: (value: unknown) => T,
): Promise<T> {
  try {
    return sanitize(JSON.parse(await readFile(filePath, "utf8")) as unknown);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return structuredClone(fallback);
    throw error;
  }
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const directory = dirname(filePath);
  await ensurePrivateDirectory(directory);
  const tempFilePath = join(directory, `.${randomUUID()}.tmp`);
  let handle;

  try {
    handle = await open(tempFilePath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempFilePath, filePath);
    if (process.platform !== "win32") await chmod(filePath, 0o600);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(tempFilePath, { force: true });
    throw error;
  }
}

export async function mutateJsonFile<T>(
  filePath: string,
  fallback: T,
  sanitize: (value: unknown) => T,
  mutation: (current: T) => T | Promise<T>,
  options: FileStoreOptions = {},
): Promise<T> {
  return withFileLock(
    filePath,
    async () => {
      const current = await readJsonFile(filePath, fallback, sanitize);
      const next = await mutation(current);
      await atomicWriteJson(filePath, next);
      return next;
    },
    options,
  );
}

export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options: FileStoreOptions = {},
): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const startedAt = Date.now();

  await ensurePrivateDirectory(dirname(filePath));

  while (true) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST") && !isTransientLockError(error))
        throw error;
      await reclaimAbandonedLock(lockPath, staleLockMs);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for local data lock: ${lockPath}`);
      }
      await delay(LOCK_RETRY_MS);
      continue;
    }

    try {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );
      return await operation();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
}

async function reclaimAbandonedLock(
  lockPath: string,
  staleLockMs: number,
): Promise<void> {
  try {
    const info = await stat(lockPath);
    const oldEnough = Date.now() - info.mtimeMs >= staleLockMs;
    let pid: number | null = null;
    try {
      const metadata = JSON.parse(await readFile(lockPath, "utf8")) as {
        pid?: unknown;
      };
      pid =
        typeof metadata.pid === "number" && Number.isInteger(metadata.pid)
          ? metadata.pid
          : null;
    } catch (error) {
      if (isTransientLockError(error) || isErrorCode(error, "ENOENT")) return;
      if (!(error instanceof SyntaxError)) throw error;
    }

    if ((pid !== null && !isProcessAlive(pid)) || (pid === null && oldEnough)) {
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if (isTransientLockError(error)) return;
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, "ESRCH");
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isTransientLockError(error: unknown): boolean {
  return (
    isErrorCode(error, "EPERM") ||
    isErrorCode(error, "EACCES") ||
    isErrorCode(error, "EBUSY")
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
