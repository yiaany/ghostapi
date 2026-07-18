import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NormalizedRequest } from "../proxy/requestNormalizer.js";

export type ApiBehavior = {
  path: string;
  method: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

const BEHAVIOR_FILE_PATH = ".ghostapi/behaviors.json";
let writeLock: Promise<void> = Promise.resolve();

export async function setApiBehavior(behavior: ApiBehavior): Promise<ApiBehavior> {
  return withWriteLock(async () => {
    const behaviors = await getApiBehaviors();
    const normalized = normalizeBehavior(behavior);
    const key = behaviorKey(normalized.method, normalized.path);
    behaviors[key] = normalized;
    await writeBehaviors(behaviors);
    return normalized;
  });
}

export async function findApiBehavior(request: NormalizedRequest): Promise<ApiBehavior | null> {
  const behaviors = await getApiBehaviors();
  return behaviors[behaviorKey(request.method, request.path)] ?? null;
}

export async function getApiBehaviors(): Promise<Record<string, ApiBehavior>> {
  try {
    const parsed = JSON.parse(await readFile(BEHAVIOR_FILE_PATH, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, ApiBehavior] => isApiBehavior(entry[1]))
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export async function clearApiBehaviorsForTests(): Promise<void> {
  await withWriteLock(async () => {
    await writeBehaviors({});
  });
}

async function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = writeLock;
  let release!: () => void;
  writeLock = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function normalizeBehavior(behavior: ApiBehavior): ApiBehavior {
  const path = behavior.path.startsWith("/") ? behavior.path : `/${behavior.path}`;
  const method = behavior.method.toUpperCase();
  if (!Number.isInteger(behavior.status) || behavior.status < 100 || behavior.status > 599) {
    throw new Error("Behavior status must be an integer between 100 and 599.");
  }
  return { ...behavior, path, method };
}

function behaviorKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

async function writeBehaviors(behaviors: Record<string, ApiBehavior>): Promise<void> {
  await mkdir(dirname(BEHAVIOR_FILE_PATH), { recursive: true });
  await writeFile(BEHAVIOR_FILE_PATH, JSON.stringify(behaviors, null, 2), "utf8");
}

function isApiBehavior(value: unknown): value is ApiBehavior {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as ApiBehavior).path === "string"
    && typeof (value as ApiBehavior).method === "string"
    && typeof (value as ApiBehavior).status === "number";
}
