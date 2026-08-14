import type { NormalizedRequest } from "../proxy/requestNormalizer.js";
import { getDataPaths } from "../config/dataPaths.js";
import { atomicWriteJson, mutateJsonFile, readJsonFile, withFileLock } from "../storage/fileStore.js";
import { sanitizeSecrets } from "../security/secrets.js";

export type ApiBehavior = {
  path: string;
  method: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
};

export async function setApiBehavior(behavior: ApiBehavior): Promise<ApiBehavior> {
  let normalizedResult!: ApiBehavior;
  await mutateJsonFile(getDataPaths().behaviors, {}, sanitizeBehaviors, (behaviors) => {
    const normalized = normalizeBehavior(behavior);
    normalizedResult = normalized;
    const key = behaviorKey(normalized.method, normalized.path);
    return { ...behaviors, [key]: normalized };
  });
  return normalizedResult;
}

export async function findApiBehavior(request: NormalizedRequest): Promise<ApiBehavior | null> {
  const behaviors = await getApiBehaviors();
  return behaviors[behaviorKey(request.method, request.path)] ?? null;
}

export async function getApiBehaviors(): Promise<Record<string, ApiBehavior>> {
  return readJsonFile(getDataPaths().behaviors, {}, sanitizeBehaviors);
}

export async function clearApiBehaviorsForTests(): Promise<void> {
  const behaviorPath = getDataPaths().behaviors;
  await withFileLock(behaviorPath, () => atomicWriteJson(behaviorPath, {}));
}

function normalizeBehavior(behavior: ApiBehavior): ApiBehavior {
  const path = behavior.path.startsWith("/") ? behavior.path : `/${behavior.path}`;
  const method = behavior.method.toUpperCase();
  if (!Number.isInteger(behavior.status) || behavior.status < 100 || behavior.status > 599) {
    throw new Error("Behavior status must be an integer between 100 and 599.");
  }
  if (behavior.delayMs !== undefined && (!Number.isInteger(behavior.delayMs) || behavior.delayMs < 0 || behavior.delayMs > 10_000)) {
    throw new Error("Behavior delayMs must be an integer between 0 and 10000.");
  }
  return sanitizeSecrets({ ...behavior, path, method }) as ApiBehavior;
}

function behaviorKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function isApiBehavior(value: unknown): value is ApiBehavior {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const behavior = value as ApiBehavior;
  return typeof behavior.path === "string"
    && typeof behavior.method === "string"
    && Number.isInteger(behavior.status)
    && behavior.status >= 100
    && behavior.status <= 599
    && (behavior.delayMs === undefined || (Number.isInteger(behavior.delayMs) && behavior.delayMs >= 0 && behavior.delayMs <= 10_000));
}

function sanitizeBehaviors(value: unknown): Record<string, ApiBehavior> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entryValue]) => [key, sanitizeSecrets(entryValue)] as const)
      .filter((entry): entry is [string, ApiBehavior] => isApiBehavior(entry[1]))
  );
}
