import { lstat, rm } from "node:fs/promises";
import { getDataPaths } from "../config/dataPaths.js";
import {
  atomicWriteJson,
  readJsonFile,
  withFileLock,
} from "../storage/fileStore.js";
import { isJsonObject } from "../utils/json.js";

const SCHEMA_VERSION = 1;
const MAX_ACTIVE_WEEKS = 8;

export type ProductTelemetryEvent =
  | "init_completed"
  | "enforced_run_completed"
  | "evidence_generated"
  | "eval_completed";

export type ProductTelemetrySnapshot = {
  schemaVersion: 1;
  enabled: boolean;
  counters: Record<ProductTelemetryEvent, number>;
  activeWeeks: string[];
  firstActivationAt?: string;
  lastActivityAt?: string;
};

export class ProductTelemetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductTelemetryError";
  }
}

export async function readProductTelemetry(): Promise<ProductTelemetrySnapshot> {
  return readSnapshot(getDataPaths().productTelemetry);
}

export async function setProductTelemetryEnabled(
  enabled: boolean,
): Promise<ProductTelemetrySnapshot> {
  const path = getDataPaths().productTelemetry;
  return withFileLock(path, async () => {
    if (!enabled) {
      await rm(path, { force: true });
      return emptySnapshot();
    }

    const current = await readSnapshot(path);
    const next = { ...current, enabled: true };
    await atomicWriteJson(path, next);
    return next;
  });
}

export async function recordProductTelemetry(
  event: ProductTelemetryEvent,
  now = new Date(),
): Promise<ProductTelemetrySnapshot> {
  if (!isTelemetryEvent(event))
    throw new ProductTelemetryError("Unknown local product telemetry event.");
  if (Number.isNaN(now.getTime()))
    throw new ProductTelemetryError(
      "Local product telemetry received an invalid clock value.",
    );

  const path = getDataPaths().productTelemetry;
  return withFileLock(path, async () => {
    const current = await readSnapshot(path);
    if (!current.enabled) return current;

    const timestamp = now.toISOString();
    if (
      current.lastActivityAt !== undefined &&
      timestamp < current.lastActivityAt
    ) {
      throw new ProductTelemetryError(
        "Local product telemetry clock moved backwards; refusing to write inconsistent activity state.",
      );
    }
    if (current.counters[event] === Number.MAX_SAFE_INTEGER) {
      throw new ProductTelemetryError(
        "Local product telemetry counter capacity reached.",
      );
    }
    const week = isoWeek(now);
    const activeWeeks = [...new Set([...current.activeWeeks, week])]
      .sort()
      .slice(-MAX_ACTIVE_WEEKS);
    const counters = {
      ...current.counters,
      [event]: current.counters[event] + 1,
    };
    const activation =
      event === "enforced_run_completed" || event === "evidence_generated";
    const next: ProductTelemetrySnapshot = {
      schemaVersion: SCHEMA_VERSION,
      enabled: true,
      counters,
      activeWeeks,
      ...(activation && current.firstActivationAt === undefined
        ? { firstActivationAt: timestamp }
        : current.firstActivationAt === undefined
          ? {}
          : { firstActivationAt: current.firstActivationAt }),
      lastActivityAt: timestamp,
    };
    await atomicWriteJson(path, next);
    return next;
  });
}

export function formatProductTelemetry(
  snapshot: ProductTelemetrySnapshot,
): string {
  const activation =
    snapshot.firstActivationAt === undefined
      ? "not reached"
      : `reached at ${snapshot.firstActivationAt}`;
  return [
    `Local product telemetry: ${snapshot.enabled ? "enabled" : "disabled"}`,
    "Network export: disabled (this feature has no network transport).",
    `Activation: ${activation}.`,
    `Active weeks retained: ${snapshot.activeWeeks.length}/${MAX_ACTIVE_WEEKS}.`,
    `Counters: init=${snapshot.counters.init_completed}, enforced-runs=${snapshot.counters.enforced_run_completed}, evidence=${snapshot.counters.evidence_generated}, evals=${snapshot.counters.eval_completed}.`,
  ].join("\n");
}

function emptySnapshot(): ProductTelemetrySnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: false,
    counters: {
      init_completed: 0,
      enforced_run_completed: 0,
      evidence_generated: 0,
      eval_completed: 0,
    },
    activeWeeks: [],
  };
}

async function readSnapshot(path: string): Promise<ProductTelemetrySnapshot> {
  const info = await lstat(path).catch((error: unknown) =>
    isErrorCode(error, "ENOENT") ? null : Promise.reject(error),
  );
  if (info === null) return emptySnapshot();
  if (!info.isFile() || info.isSymbolicLink())
    throw new ProductTelemetryError(
      "Local product telemetry must be a regular non-symlink file.",
    );
  return readJsonFile(path, emptySnapshot(), parseSnapshot);
}

function parseSnapshot(value: unknown): ProductTelemetrySnapshot {
  if (!isJsonObject(value))
    throw new ProductTelemetryError(
      "Local product telemetry file must be a JSON object.",
    );
  assertExactKeys(value, [
    "schemaVersion",
    "enabled",
    "counters",
    "activeWeeks",
    "firstActivationAt",
    "lastActivityAt",
  ]);
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    typeof value.enabled !== "boolean"
  )
    throw new ProductTelemetryError(
      "Local product telemetry file has an unsupported schema.",
    );
  if (!isJsonObject(value.counters))
    throw new ProductTelemetryError(
      "Local product telemetry counters must be an object.",
    );
  assertExactKeys(value.counters, [
    "init_completed",
    "enforced_run_completed",
    "evidence_generated",
    "eval_completed",
  ]);

  const counters = {} as Record<ProductTelemetryEvent, number>;
  for (const event of [
    "init_completed",
    "enforced_run_completed",
    "evidence_generated",
    "eval_completed",
  ] as const) {
    const count = value.counters[event];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw new ProductTelemetryError(
        "Local product telemetry counters must be non-negative safe integers.",
      );
    counters[event] = count;
  }

  if (
    !Array.isArray(value.activeWeeks) ||
    value.activeWeeks.length > MAX_ACTIVE_WEEKS ||
    !value.activeWeeks.every(
      (week) => typeof week === "string" && /^\d{4}-W\d{2}$/.test(week),
    )
  ) {
    throw new ProductTelemetryError(
      "Local product telemetry active weeks are invalid.",
    );
  }
  const activeWeeks = [...new Set(value.activeWeeks)].sort();
  if (activeWeeks.length !== value.activeWeeks.length)
    throw new ProductTelemetryError(
      "Local product telemetry active weeks must be unique.",
    );

  const firstActivationAt = parseTimestamp(value.firstActivationAt);
  const lastActivityAt = parseTimestamp(value.lastActivityAt);
  if (
    firstActivationAt !== undefined &&
    lastActivityAt !== undefined &&
    firstActivationAt > lastActivityAt
  ) {
    throw new ProductTelemetryError(
      "Local product telemetry timestamps are out of order.",
    );
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: value.enabled,
    counters,
    activeWeeks,
    ...(firstActivationAt === undefined ? {} : { firstActivationAt }),
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
  };
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ProductTelemetryError(
      "Local product telemetry file contains unsupported fields.",
    );
}

function parseTimestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new ProductTelemetryError(
      "Local product telemetry timestamp is invalid.",
    );
  return value;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isTelemetryEvent(value: string): value is ProductTelemetryEvent {
  return (
    value === "init_completed" ||
    value === "enforced_run_completed" ||
    value === "evidence_generated" ||
    value === "eval_completed"
  );
}

function isoWeek(date: Date): string {
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
