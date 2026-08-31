import { utimes, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveDataPath } from "../src/config/dataPaths.js";
import {
  ensurePrivateDirectory,
  withFileLock,
} from "../src/storage/fileStore.js";

describe("file store locking", () => {
  it("reclaims malformed abandoned lock files", async () => {
    const filePath = resolveDataPath("malformed-lock.json");
    const lockPath = `${filePath}.lock`;
    await ensurePrivateDirectory(resolveDataPath());
    await writeFile(lockPath, "{partial", "utf8");
    await utimes(lockPath, new Date(0), new Date(0));

    await expect(
      withFileLock(filePath, async () => "acquired", {
        staleLockMs: 0,
        lockTimeoutMs: 500,
      }),
    ).resolves.toBe("acquired");
  });
});
