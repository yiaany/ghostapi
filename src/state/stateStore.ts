import { dirname } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isJsonObject } from "../utils/json.js";

const STATE_FILE_PATH = ".ghostapi/state.json";
let writeLock: Promise<void> = Promise.resolve();

export async function initializeStateStore(): Promise<void> {
  const release = await acquireLock();
  try {
    await mkdir(dirname(STATE_FILE_PATH), { recursive: true });
    try {
      await readFile(STATE_FILE_PATH, "utf8");
    } catch {
      await writeFile(STATE_FILE_PATH, JSON.stringify({}, null, 2), "utf8");
    }
  } finally {
    release();
  }
}

export async function getStateStore(): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(STATE_FILE_PATH, "utf8");
    const parsed = JSON.parse(content);
    return isJsonObject(parsed) ? parsed : {};
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function saveToStateStore(id: string, obj: unknown): Promise<void> {
  const release = await acquireLock();
  try {
    const state = await getStateStore();
    state[id] = obj;

    await mkdir(dirname(STATE_FILE_PATH), { recursive: true });
    await writeFile(STATE_FILE_PATH, JSON.stringify(state, null, 2), "utf8");
  } finally {
    release();
  }
}

export async function clearState(): Promise<void> {
  const release = await acquireLock();
  try {
    try {
      await rm(STATE_FILE_PATH, { force: true });
    } catch {
      // Ignore if not present
    }
    await mkdir(dirname(STATE_FILE_PATH), { recursive: true });
    await writeFile(STATE_FILE_PATH, JSON.stringify({}, null, 2), "utf8");
  } finally {
    release();
  }
}

async function acquireLock(): Promise<() => void> {
  let release!: () => void;
  const nextLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  
  const currentLock = writeLock;
  writeLock = currentLock.then(() => nextLock);
  
  await currentLock;
  return release;
}