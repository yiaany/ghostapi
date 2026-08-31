import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { sanitizeSecretString } from "../security/secrets.js";
import {
  atomicWriteJson,
  ensurePrivateDirectory,
  withFileLock,
} from "../storage/fileStore.js";

const SCHEMA_VERSION = 1;
const KIND = "ghostapi.slo";
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_TARGETS = 32;
const MAX_SAMPLES_PER_METRIC = 5_000;
const MAX_SAMPLES = 10_000;
const MAX_RECORD_BATCH = 1_000;
const MIN_WINDOW_MS = 60 * 60 * 1000;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const SLO_METRICS = [
  "policy_decision",
  "approval_delivery",
  "execution_latency",
  "availability",
  "duplicate_prevention",
  "receipt_verification",
] as const;
export type SloMetric = (typeof SLO_METRICS)[number];
export const SLO_LATENCY_METRICS = [
  "approval_delivery",
  "execution_latency",
] as const;
export type SloOperatorPermission = "slo.configure" | "slo.inspect";
export type SloOperator = {
  id: string;
  principalId: string;
  permissions: readonly SloOperatorPermission[];
};
export interface SloOperatorAuthorizer {
  authenticate(identity: unknown): Promise<SloOperator>;
}

export type SloSample = {
  schemaVersion: 1;
  kind: "ghostapi.slo-sample";
  sampleId: string;
  metric: SloMetric;
  ok: boolean;
  durationMs?: number;
  recordedAt: string;
  runId?: string;
  actionId?: string;
  labels: {
    tenantId?: string;
    agentId?: string;
    projectId?: string;
    provider?: string;
    actionClass?: string;
    workflowId?: string;
  };
};

export type SloTarget = {
  id: string;
  metric: SloMetric;
  windowMs: number;
  minimumSamples: number;
  targetBps: number;
  latencyMaxMs?: number;
  description?: string;
};

export type SloEvaluation = {
  targetId: string;
  metric: SloMetric;
  targetBps: number;
  status: "met" | "breached" | "insufficient_data";
  windowMs: number;
  sampleCount: number;
  okCount: number;
  okRateBps: number;
  budgetRemainingBps: number;
  latencyMaxMs?: number;
};

export type SloReport = {
  schemaVersion: 1;
  kind: "ghostapi.slo-report";
  generatedAt: string;
  runId: string;
  windowStart: string;
  windowEnd: string;
  evaluations: SloEvaluation[];
};

export type SloStoreState = {
  schemaVersion: 1;
  kind: "ghostapi.slo";
  targets: SloTarget[];
  samples: SloSample[];
};

export type SloRecordSampleInput = {
  metric: SloMetric;
  ok: boolean;
  durationMs?: number;
  runId?: string;
  actionId?: string;
  labels?: {
    tenantId?: string;
    agentId?: string;
    projectId?: string;
    provider?: string;
    actionClass?: string;
    workflowId?: string;
  };
};

export type SloControllerOptions = {
  path?: string;
  now?: () => Date;
  operatorAuthorizer?: SloOperatorAuthorizer;
};

export class SloError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SloError";
  }
}

const sloRecordCapabilities = new WeakSet<object>();

export function createSloRecordIdentity(): object {
  const capability = Object.freeze({});
  sloRecordCapabilities.add(capability);
  return capability;
}

export function createLocalSloController(
  options: SloControllerOptions = {},
): LocalSloController {
  return new LocalSloController(options);
}

export class LocalSloController {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly operatorAuthorizer: SloOperatorAuthorizer;

  constructor(options: SloControllerOptions = {}) {
    this.path = options.path ?? getDataPaths().sloStore;
    this.now = options.now ?? (() => new Date());
    this.operatorAuthorizer =
      options.operatorAuthorizer ?? createDisabledSloOperatorAuthorizer();
  }

  async configureTarget(input: {
    identity: unknown;
    target: unknown;
  }): Promise<SloTarget> {
    await this.authorize(input.identity, "slo.configure");
    const target = validateTarget(input.target);
    return this.mutate((state) => {
      const existing = state.targets.find(
        (candidate) => candidate.id === target.id,
      );
      if (existing === undefined) {
        if (state.targets.length >= MAX_TARGETS)
          throw new SloError("SLO target limit was reached.");
        state.targets.push(target);
      } else {
        Object.assign(existing, target);
      }
      return clone(target);
    });
  }

  async removeTarget(input: {
    identity: unknown;
    targetId: string;
  }): Promise<void> {
    await this.authorize(input.identity, "slo.configure");
    const targetId = identifier(input.targetId, "SLO target id");
    await this.mutate((state) => {
      const index = state.targets.findIndex(
        (candidate) => candidate.id === targetId,
      );
      if (index === -1) throw new SloError("SLO target was not found.");
      state.targets.splice(index, 1);
    });
  }

  async recordSample(
    input: SloRecordSampleInput,
    capability: object,
  ): Promise<SloSample> {
    this.assertRecordPermission(capability);
    const sample = validateSample(input, this.now().toISOString());
    return this.mutate((state) => {
      trimSamples(state, this.windowBoundary());
      state.samples.push(sample);
      trimSamples(state, this.windowBoundary());
      return clone(sample);
    });
  }

  async recordSamples(
    input: SloRecordSampleInput[],
    capability: object,
  ): Promise<SloSample[]> {
    this.assertRecordPermission(capability);
    if (input.length > MAX_RECORD_BATCH)
      throw new SloError(
        `SLO record batch is too large; limit is ${MAX_RECORD_BATCH} samples per call.`,
      );
    const now = this.now().toISOString();
    const recorded = input.map((sample) => validateSample(sample, now));
    return this.mutate((state) => {
      trimSamples(state, this.windowBoundary());
      for (const sample of recorded) state.samples.push(sample);
      trimSamples(state, this.windowBoundary());
      return clone(recorded);
    });
  }

  async evaluate(input: {
    identity: unknown;
    runId?: string;
  }): Promise<SloReport> {
    await this.authorize(input.identity, "slo.inspect");
    const now = this.timestamp();
    const runId =
      input.runId === undefined
        ? `slo-${randomUUID().replace(/-/g, "").slice(0, 32)}`
        : identifier(input.runId, "SLO run id");
    const state = await this.read();
    const windowEnd = now;
    const windowStart = new Date(
      Date.parse(windowEnd) - MAX_WINDOW_MS,
    ).toISOString();
    const evaluations = state.targets.map((target) =>
      evaluateTarget(target, state.samples, now),
    );
    return {
      schemaVersion: 1,
      kind: "ghostapi.slo-report",
      generatedAt: now,
      runId,
      windowStart,
      windowEnd,
      evaluations,
    };
  }

  async inspect(input: { identity: unknown }): Promise<{
    targets: SloTarget[];
    sampleCounts: Record<SloMetric, number>;
  }> {
    await this.authorize(input.identity, "slo.inspect");
    const state = await this.read();
    const sampleCounts = Object.fromEntries(
      SLO_METRICS.map((metric) => [
        metric,
        state.samples.filter((sample) => sample.metric === metric).length,
      ]),
    ) as Record<SloMetric, number>;
    return { targets: clone(state.targets), sampleCounts };
  }

  private assertRecordPermission(capability: object): void {
    if (
      capability !== null &&
      typeof capability === "object" &&
      sloRecordCapabilities.has(capability)
    )
      return;
    throw new SloError(
      "SLO sample recording requires a verified record capability.",
    );
  }

  private async authorize(
    identity: unknown,
    permission: SloOperatorPermission,
  ): Promise<SloOperator> {
    const operator = validateOperator(
      await this.operatorAuthorizer.authenticate(identity),
    );
    if (!operator.permissions.includes(permission))
      throw new SloError(
        `SLO operator lacks required permission: ${permission}.`,
      );
    return operator;
  }

  private windowBoundary(): string {
    return new Date(Date.parse(this.timestamp()) - MAX_WINDOW_MS).toISOString();
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      throw new SloError("SLO clock is invalid.");
    return value.toISOString();
  }

  private async read(): Promise<SloStoreState> {
    await ensurePrivateDirectory(dirname(this.path));
    const info = await lstat(this.path).catch((error: unknown) =>
      isErrorCode(error, "ENOENT") ? null : Promise.reject(error),
    );
    if (info === null) return emptyState();
    if (!info.isFile() || info.isSymbolicLink())
      throw new SloError("SLO store must be a regular non-symlink file.");
    const source = await readFile(this.path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_STORE_BYTES)
      throw new SloError("SLO store exceeds its size limit.");
    try {
      return validateState(JSON.parse(source));
    } catch (error) {
      if (error instanceof SloError) throw error;
      throw new SloError("SLO store is not valid JSON.");
    }
  }

  private async mutate<T>(operation: (state: SloStoreState) => T): Promise<T> {
    return withFileLock(this.path, async () => {
      const state = await this.read();
      const result = operation(state);
      await atomicWriteJson(this.path, validateState(state));
      return result;
    });
  }
}

export function createDisabledSloOperatorAuthorizer(): SloOperatorAuthorizer {
  return {
    async authenticate(): Promise<never> {
      throw new SloError("SLO operator authorization is not configured.");
    },
  };
}

export function createTestSloOperatorAuthorizer(): {
  authorizer: SloOperatorAuthorizer;
  issue(input: SloOperator): SloOperator;
} {
  const issued = new WeakSet<object>();
  return {
    authorizer: {
      async authenticate(identity: unknown): Promise<SloOperator> {
        if (
          identity === null ||
          typeof identity !== "object" ||
          !issued.has(identity)
        )
          throw new SloError("SLO operator identity is not authenticated.");
        return validateOperator(identity);
      },
    },
    issue(input): SloOperator {
      const operator = Object.freeze(validateOperator(input));
      issued.add(operator);
      return operator;
    },
  };
}

export function examplePilotSloTargets(): SloTarget[] {
  return [
    {
      id: "pilot.availability",
      metric: "availability",
      windowMs: 60 * 60 * 1000,
      minimumSamples: 10,
      targetBps: 9_990,
      description:
        "Example pilot target: 99.9% of executed actions complete without a failed or ambiguous outcome.",
    },
    {
      id: "pilot.duplicate_prevention",
      metric: "duplicate_prevention",
      windowMs: 60 * 60 * 1000,
      minimumSamples: 10,
      targetBps: 10_000,
      description:
        "Example pilot target: no action produces more than one provider receipt in the local ledger.",
    },
    {
      id: "pilot.receipt_verification",
      metric: "receipt_verification",
      windowMs: 60 * 60 * 1000,
      minimumSamples: 10,
      targetBps: 9_950,
      description:
        "Example pilot target: committed actions carry a verified provider receipt.",
    },
    {
      id: "pilot.execution_latency",
      metric: "execution_latency",
      windowMs: 60 * 60 * 1000,
      minimumSamples: 10,
      targetBps: 9_900,
      latencyMaxMs: 5_000,
      description:
        "Example pilot target: 99% of executions finish within 5 seconds.",
    },
    {
      id: "pilot.policy_decision",
      metric: "policy_decision",
      windowMs: 60 * 60 * 1000,
      minimumSamples: 10,
      targetBps: 9_990,
      description:
        "Example pilot target: policy decisions recorded in the ledger are always admitted.",
    },
    {
      id: "pilot.approval_delivery",
      metric: "approval_delivery",
      windowMs: 60 * 60 * 1000,
      minimumSamples: 10,
      targetBps: 9_990,
      latencyMaxMs: 5 * 60 * 1000,
      description:
        "Example pilot target: approval artifacts reach execution within 5 minutes.",
    },
  ];
}

export function formatSloReport(report: SloReport): string {
  const lines = [`SLO report ${report.runId} at ${report.generatedAt}`];
  if (report.evaluations.length === 0)
    lines.push("  (no SLO targets configured)");
  for (const evaluation of report.evaluations) {
    const status =
      evaluation.status === "met"
        ? "met"
        : evaluation.status === "breached"
          ? "BREACHED"
          : "insufficient data";
    const budget =
      evaluation.status === "met"
        ? ` (budget remaining ${evaluation.budgetRemainingBps} bps)`
        : evaluation.status === "breached"
          ? ` (short ${Math.abs(evaluation.budgetRemainingBps)} bps)`
          : "";
    lines.push(
      `  ${evaluation.metric} [${evaluation.targetId}] ${status} ok ${evaluation.okCount}/${evaluation.sampleCount} = ${evaluation.okRateBps} bps vs ${evaluation.targetBps} bps${budget}${evaluation.latencyMaxMs === undefined ? "" : ` (latency max ${evaluation.latencyMaxMs} ms)`}`,
    );
  }
  return lines.join("\n");
}

function emptyState(): SloStoreState {
  return { schemaVersion: 1, kind: "ghostapi.slo", targets: [], samples: [] };
}

function validateState(value: unknown): SloStoreState {
  const state = object(value, "SLO store must be an object.");
  exactKeys(
    state,
    ["schemaVersion", "kind", "targets", "samples"],
    "SLO store",
  );
  if (state.schemaVersion !== SCHEMA_VERSION || state.kind !== KIND)
    throw new SloError("Unsupported SLO store schema.");
  const targets = array(state.targets, "SLO targets", MAX_TARGETS).map(
    validateTarget,
  );
  unique(
    targets.map((target) => target.id),
    "SLO target ids",
  );
  const samples = array(state.samples, "SLO samples", MAX_SAMPLES).map(
    validateStoredSample,
  );
  return { schemaVersion: 1, kind: "ghostapi.slo", targets, samples };
}

function validateTarget(value: unknown): SloTarget {
  const target = object(value, "SLO target is invalid.");
  exactKeys(
    target,
    [
      "id",
      "metric",
      "windowMs",
      "minimumSamples",
      "targetBps",
      "latencyMaxMs",
      "description",
    ],
    "SLO target",
    ["latencyMaxMs", "description"],
  );
  if (!SLO_METRICS.includes(target.metric as SloMetric))
    throw new SloError("SLO target metric is invalid.");
  const result: SloTarget = {
    id: identifier(target.id, "SLO target id"),
    metric: target.metric as SloMetric,
    windowMs: boundedMs(target.windowMs, "SLO target window"),
    minimumSamples: positive(
      target.minimumSamples,
      "SLO target minimum samples",
      MAX_SAMPLES_PER_METRIC,
    ),
    targetBps: bps(target.targetBps, "SLO target rate"),
    ...(target.latencyMaxMs === undefined
      ? {}
      : {
          latencyMaxMs: nonNegative(
            target.latencyMaxMs,
            "SLO target latency",
            24 * 60 * 60 * 1000,
          ),
        }),
    ...(target.description === undefined
      ? {}
      : {
          description: text(target.description, "SLO target description", 240),
        }),
  };
  if (
    (SLO_LATENCY_METRICS as readonly string[]).includes(result.metric) &&
    result.latencyMaxMs === undefined
  )
    throw new SloError("Latency SLO targets require a latencyMaxMs bound.");
  return result;
}

function validateStoredSample(value: unknown): SloSample {
  const sample = object(value, "SLO sample is invalid.");
  exactKeys(
    sample,
    [
      "schemaVersion",
      "kind",
      "sampleId",
      "metric",
      "ok",
      "durationMs",
      "recordedAt",
      "runId",
      "actionId",
      "labels",
    ],
    "SLO sample",
    ["durationMs", "runId", "actionId"],
  );
  if (
    sample.schemaVersion !== SCHEMA_VERSION ||
    sample.kind !== "ghostapi.slo-sample"
  )
    throw new SloError("Unsupported SLO sample schema.");
  if (
    !SLO_METRICS.includes(sample.metric as SloMetric) ||
    typeof sample.ok !== "boolean"
  )
    throw new SloError("SLO sample metric or ok flag is invalid.");
  return {
    schemaVersion: 1,
    kind: "ghostapi.slo-sample",
    sampleId: identifier(sample.sampleId, "SLO sample id"),
    metric: sample.metric as SloMetric,
    ok: sample.ok,
    ...(sample.durationMs === undefined
      ? {}
      : {
          durationMs: nonNegative(
            sample.durationMs,
            "SLO sample duration",
            24 * 60 * 60 * 1000,
          ),
        }),
    recordedAt: timestamp(sample.recordedAt, "SLO sample time"),
    ...(sample.runId === undefined
      ? {}
      : { runId: identifier(sample.runId, "SLO sample run id") }),
    ...(sample.actionId === undefined
      ? {}
      : { actionId: identifier(sample.actionId, "SLO sample action id") }),
    labels: validateLabels(sample.labels),
  };
}

function validateSample(input: SloRecordSampleInput, now: string): SloSample {
  if (!SLO_METRICS.includes(input.metric))
    throw new SloError("SLO sample metric is invalid.");
  if (typeof input.ok !== "boolean")
    throw new SloError("SLO sample ok flag is invalid.");
  const result: SloSample = {
    schemaVersion: 1,
    kind: "ghostapi.slo-sample",
    sampleId: `sample-${randomUUID().replace(/-/g, "").slice(0, 32)}`,
    metric: input.metric,
    ok: input.ok,
    ...(input.durationMs === undefined
      ? {}
      : {
          durationMs: nonNegative(
            input.durationMs,
            "SLO sample duration",
            24 * 60 * 60 * 1000,
          ),
        }),
    recordedAt: now,
    ...(input.runId === undefined
      ? {}
      : { runId: identifier(input.runId, "SLO sample run id") }),
    ...(input.actionId === undefined
      ? {}
      : { actionId: identifier(input.actionId, "SLO sample action id") }),
    labels: input.labels === undefined ? {} : validateLabels(input.labels),
  };
  return result;
}

function validateLabels(value: unknown): SloSample["labels"] {
  const labels = object(value ?? {}, "SLO sample labels are invalid.");
  exactKeys(
    labels,
    [
      "tenantId",
      "agentId",
      "projectId",
      "provider",
      "actionClass",
      "workflowId",
    ],
    "SLO sample labels",
  );
  const result: SloSample["labels"] = {};
  for (const key of [
    "tenantId",
    "agentId",
    "projectId",
    "provider",
    "actionClass",
    "workflowId",
  ] as const) {
    if (labels[key] !== undefined)
      result[key] = identifier(labels[key], `SLO label ${key}`);
  }
  return result;
}

function evaluateTarget(
  target: SloTarget,
  samples: SloSample[],
  now: string,
): SloEvaluation {
  const windowStart = Date.parse(now) - target.windowMs;
  const inWindow = samples.filter(
    (sample) =>
      sample.metric === target.metric &&
      Date.parse(sample.recordedAt) >= windowStart &&
      Date.parse(sample.recordedAt) <= Date.parse(now) + 1_000,
  );
  if (inWindow.length < target.minimumSamples) {
    return {
      targetId: target.id,
      metric: target.metric,
      targetBps: target.targetBps,
      status: "insufficient_data",
      windowMs: target.windowMs,
      sampleCount: inWindow.length,
      okCount: 0,
      okRateBps: 0,
      budgetRemainingBps: 0,
      ...(target.latencyMaxMs === undefined
        ? {}
        : { latencyMaxMs: target.latencyMaxMs }),
    };
  }
  let okCount = 0;
  for (const sample of inWindow) {
    if ((SLO_LATENCY_METRICS as readonly string[]).includes(sample.metric)) {
      if (
        sample.ok &&
        sample.durationMs !== undefined &&
        sample.durationMs <= target.latencyMaxMs!
      )
        okCount += 1;
    } else if (sample.ok) {
      okCount += 1;
    }
  }
  const okRateBps = rateBps(okCount, inWindow.length);
  const status = okRateBps >= target.targetBps ? "met" : "breached";
  return {
    targetId: target.id,
    metric: target.metric,
    targetBps: target.targetBps,
    status,
    windowMs: target.windowMs,
    sampleCount: inWindow.length,
    okCount,
    okRateBps,
    budgetRemainingBps: okRateBps - target.targetBps,
    ...(target.latencyMaxMs === undefined
      ? {}
      : { latencyMaxMs: target.latencyMaxMs }),
  };
}

function trimSamples(state: SloStoreState, boundary: string): void {
  const boundaryMs = Date.parse(boundary);
  state.samples = state.samples.filter(
    (sample) => Date.parse(sample.recordedAt) >= boundaryMs,
  );
  for (const metric of SLO_METRICS) {
    const metricSamples = state.samples.filter(
      (sample) => sample.metric === metric,
    );
    if (metricSamples.length > MAX_SAMPLES_PER_METRIC) {
      const ids = new Set(
        metricSamples
          .slice(0, metricSamples.length - MAX_SAMPLES_PER_METRIC)
          .map((sample) => sample.sampleId),
      );
      state.samples = state.samples.filter(
        (sample) => sample.metric !== metric || !ids.has(sample.sampleId),
      );
    }
  }
  if (state.samples.length > MAX_SAMPLES) {
    state.samples = state.samples.slice(state.samples.length - MAX_SAMPLES);
  }
}

function validateOperator(value: unknown): SloOperator {
  const operator = object(value, "SLO operator is invalid.");
  exactKeys(operator, ["id", "principalId", "permissions"], "SLO operator");
  const permissions = array(
    operator.permissions,
    "SLO operator permissions",
    8,
  ).map((permission) => {
    if (permission !== "slo.configure" && permission !== "slo.inspect")
      throw new SloError("SLO operator permission is invalid.");
    return permission as SloOperatorPermission;
  });
  unique(permissions, "SLO operator permissions");
  return {
    id: identifier(operator.id, "SLO operator id"),
    principalId: identifier(operator.principalId, "SLO operator principal id"),
    permissions,
  };
}

function boundedMs(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_WINDOW_MS ||
    value > MAX_WINDOW_MS
  )
    throw new SloError(`${label} must be between one hour and 30 days.`);
  return value;
}

function positive(value: unknown, label: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new SloError(`${label} is invalid.`);
  return value;
}

function nonNegative(value: unknown, label: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new SloError(`${label} is invalid.`);
  return value;
}

function bps(value: unknown, label: string): number {
  return nonNegative(value, label, 10_000);
}

function rateBps(count: number, total: number): number {
  return total === 0 ? 0 : Math.floor((count * 10_000) / total);
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !IDENTIFIER.test(value) ||
    sanitizeSecretString(value) !== value
  )
    throw new SloError(`${label} must be a safe identifier.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new SloError(`${label} must be an ISO UTC timestamp.`);
  return value;
}

function text(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value) ||
    sanitizeSecretString(value) !== value
  )
    throw new SloError(`${label} is invalid.`);
  return value.trim();
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new SloError(message);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new SloError(`${label} is invalid.`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
  optional: string[] = [],
): void {
  for (const key of Object.keys(value))
    if (
      !keys.includes(key) ||
      (value[key] === undefined && !optional.includes(key))
    )
      throw new SloError(`${label} contains unsupported field: ${key}`);
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new SloError(`${label} must be unique.`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
