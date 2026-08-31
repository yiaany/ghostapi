import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll } from "vitest";
import { drainEventWrites } from "../src/server/eventsStore.js";

const testDataDir = join(
  tmpdir(),
  `ghostapi-tests-${process.pid}-${randomUUID()}`,
);
process.env.GHOSTAPI_DATA_DIR = testDataDir;

afterAll(async () => {
  await drainEventWrites();
  await rm(testDataDir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
});
