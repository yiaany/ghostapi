import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";

const SCHEMA_VERSION = 1;
const KIND = "ghostapi.costs";
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const MAX_BUDGETS = 32;
const MAX_ALERTS = 100;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const COST_DIMENSIONS = ["agent", "project", "provider", "action_class", "workflow"] as const;
export type CostDimension = (typeof COST_DIMENSIONS)[number];
export const COST_AMOUNT_KEYS = ["monetaryAmountMinor", "requests", "messages", "mutations", "deletes", "tokenCost"] as const;
export type CostAmountKey = (typeof COST_AMOUNT_KEYS)[number];
export type CostAmounts = Record<CostAmountKey, number>;

export type CostAttribution = { agentId: string; projectId: string; provider: string; actionClass: string; workflowId: string };
const ATTRIBUTION_DIMENSION_KEY: Record<CostDimension, keyof CostAttribution> = {
  agent: "agentId",
  project: "projectId",
  provider: "provider",
  action_class: "actionClass",
  workflow: "workflowId"
};
export type CostRecord = {
  schemaVersion: 1;
  kind: "ghostapi.cost-record";
  recordId: string;
  tenantId: string;
  runId: string;
  actionId: string;
  recordedAt: string;
  attribution: CostAttribution;
  amounts: CostAmounts;
};
export type CostBudget = {
  id: string;
  scope: { dimension: CostDimension; value: string };
  windowMs: number;
  limits: Partial<Record<CostAmountKey, number>>;
  alertOnExceed: boolean;
};
export type CostAlert = {
  id: string;
  budgetId: string;
  scope: { dimension: CostDimension; value: string };
  windowMs: number;
  windowStart: string;
  windowEnd: string;
  exceeded: Array<{ key: CostAmountKey; limit: number; total: number }>;
  created: string;
  status: "open" | "acknowledged";
  acknowledgedBy?: string;
  acknowledgedAt?: string;
};
export type CostForecast = {
  method: "linear-extrapolation";
  approximation: true;
  projectionDays: number;
  sampleDays: number;
  sampleStart: string;
  sampleEnd: string;
  averagePerDay: CostAmounts;
  trendPerDay: CostAmounts;
  nextPeriodEstimate: CostAmounts;
  disclaimer: string;
};
export type CostBudgetEvaluation = {
  id: string;
  scope: { dimension: CostDimension; value: string };
  windowMs: number;
  limits: Partial<Record<CostAmountKey, number>>;
  totals: CostAmounts;
  status: "within" | "exceeded";
  exceeded: Array<{ key: CostAmountKey; limit: number; total: number }>;
};
export type CostReport = {
  schemaVersion: 1;
  kind: "ghostapi.cost-report";
  tenantId: string;
  generatedAt: string;
  runId: string;
  windowMs: number;
  windowStart: string;
  windowEnd: string;
  source: string;
  totals: CostAmounts;
  attribution: Array<{ dimension: CostDimension; value: string; totals: CostAmounts }>;
  budgets: CostBudgetEvaluation[];
  alerts: CostAlert[];
  forecast: CostForecast;
};

export type CostStoreState = {
  schemaVersion: 1;
  kind: "ghostapi.costs";
  records: CostRecord[];
  budgets: CostBudget[];
  alerts: CostAlert[];
};

export type CostOperatorPermission = "cost.record" | "cost.configure" | "cost.inspect" | "cost.acknowledge";
export type CostOperator = { id: string; principalId: string; permissions: readonly CostOperatorPermission[]; tenantId?: string };
export interface CostOperatorAuthorizer { authenticate(identity: unknown): Promise<CostOperator>; }

export type CostControllerOptions = {
  path?: string;
  now?: () => Date;
  operatorAuthorizer?: CostOperatorAuthorizer;
};

export type RecordCostInput = {
  tenantId: string;
  runId: string;
  actionId: string;
  attribution: CostAttribution;
  amounts: CostAmounts;
};

export class CostGovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostGovernanceError";
  }
}

export function createLocalCostGovernance(options: CostControllerOptions = {}): LocalCostGovernance {
  return new LocalCostGovernance(options);
}

export class LocalCostGovernance {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly operatorAuthorizer: CostOperatorAuthorizer;

  constructor(options: CostControllerOptions = {}) {
    this.path = options.path ?? getDataPaths().costStore;
    this.now = options.now ?? (() => new Date());
    this.operatorAuthorizer = options.operatorAuthorizer ?? createDisabledCostOperatorAuthorizer();
  }

  async recordCost(input: { identity: unknown; record: RecordCostInput }): Promise<CostRecord> {
    await this.authorize(input.identity, "cost.record");
    const record = validateRecordInput(input.record, this.timestamp());
    return this.mutate((state) => {
      if (state.records.some((candidate) => candidate.tenantId === record.tenantId && candidate.actionId === record.actionId)) throw new CostGovernanceError("Cost record already exists for this tenant and action.");
      if (state.records.length >= MAX_RECORDS) throw new CostGovernanceError("Cost record limit was reached; export and retention review are required.");
      state.records.push(record);
      return clone(record);
    });
  }

  async configureBudget(input: { identity: unknown; budget: unknown }): Promise<CostBudget> {
    await this.authorize(input.identity, "cost.configure");
    const budget = validateBudget(input.budget);
    return this.mutate((state) => {
      const existing = state.budgets.find((candidate) => candidate.id === budget.id);
      if (existing === undefined) {
        if (state.budgets.length >= MAX_BUDGETS) throw new CostGovernanceError("Cost budget limit was reached.");
        state.budgets.push(budget);
      } else {
        Object.assign(existing, budget);
      }
      return clone(budget);
    });
  }

  async removeBudget(input: { identity: unknown; budgetId: string }): Promise<void> {
    await this.authorize(input.identity, "cost.configure");
    const budgetId = identifier(input.budgetId, "Cost budget id");
    await this.mutate((state) => {
      const index = state.budgets.findIndex((candidate) => candidate.id === budgetId);
      if (index === -1) throw new CostGovernanceError("Cost budget was not found.");
      state.budgets.splice(index, 1);
    });
  }

  async report(input: { identity: unknown; windowMs?: number; projectionDays?: number; runId?: string }): Promise<CostReport> {
    const operator = await this.authorize(input.identity, "cost.inspect");
    const windowMs = input.windowMs === undefined ? 30 * 24 * 60 * 60 * 1000 : boundedMs(input.windowMs, "Cost report window");
    const projectionDays = input.projectionDays === undefined ? 7 : boundedDays(input.projectionDays, "Cost projection days");
    const now = this.timestamp();
    const runId = input.runId === undefined ? `cost-${randomUUID().replace(/-/g, "").slice(0, 32)}` : identifier(input.runId, "Cost report run id");
    const state = await this.read();
    const inWindow = tenantScoped(state.records, operator.tenantId).filter((record) => Date.parse(record.recordedAt) >= Date.parse(now) - windowMs && Date.parse(record.recordedAt) <= Date.parse(now) + 1_000);
    const totals = sumAmounts(inWindow.map((record) => record.amounts));
    const attribution = aggregateAttribution(inWindow);
    const evaluations = state.budgets.map((budget) => evaluateBudget(budget, inWindow, now));
    const alerts = deriveAlerts(state.alerts, evaluations, state.budgets, now);
    const forecast = buildForecast(inWindow, projectionDays, now, windowMs);
    return {
      schemaVersion: 1,
      kind: "ghostapi.cost-report",
      tenantId: operator.tenantId ?? "ghostapi-local",
      generatedAt: now,
      runId,
      windowMs,
      windowStart: new Date(Date.parse(now) - windowMs).toISOString(),
      windowEnd: now,
      source: "Local cost records are synthetic action metadata (counts and token estimates). They are not provider invoices and must be calibrated against real billing during the pilot.",
      totals,
      attribution,
      budgets: evaluations,
      alerts: clone(alerts),
      forecast
    };
  }

  async listAlerts(input: { identity: unknown }): Promise<CostAlert[]> {
    await this.authorize(input.identity, "cost.inspect");
    const now = this.timestamp();
    return this.mutate((state) => {
      const inWindow = state.records.filter((record) => Date.parse(record.recordedAt) >= Date.parse(now) - MAX_WINDOW_MS);
      const evaluations = state.budgets.map((budget) => evaluateBudget(budget, inWindow, now));
      state.alerts = deriveAlerts(state.alerts, evaluations, state.budgets, now);
      return clone(state.alerts);
    });
  }

  async acknowledgeAlert(input: { identity: unknown; alertId: string }): Promise<CostAlert> {
    const operator = await this.authorize(input.identity, "cost.acknowledge");
    const alertId = identifier(input.alertId, "Cost alert id");
    return this.mutate((state) => {
      const alert = state.alerts.find((candidate) => candidate.id === alertId);
      if (alert === undefined) throw new CostGovernanceError("Cost alert was not found.");
      if (alert.status === "acknowledged") throw new CostGovernanceError("Cost alert is already acknowledged.");
      alert.status = "acknowledged";
      alert.acknowledgedBy = operator.principalId;
      alert.acknowledgedAt = this.timestamp();
      return clone(alert);
    });
  }

  private async authorize(identity: unknown, permission: CostOperatorPermission): Promise<CostOperator> {
    const operator = validateOperator(await this.operatorAuthorizer.authenticate(identity));
    if (!operator.permissions.includes(permission)) throw new CostGovernanceError(`Cost operator lacks required permission: ${permission}.`);
    return operator;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new CostGovernanceError("Cost governance clock is invalid.");
    return value.toISOString();
  }

  private async read(): Promise<CostStoreState> {
    await ensurePrivateDirectory(dirname(this.path));
    const info = await lstat(this.path).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
    if (info === null) return emptyState();
    if (!info.isFile() || info.isSymbolicLink()) throw new CostGovernanceError("Cost store must be a regular non-symlink file.");
    const source = await readFile(this.path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_STORE_BYTES) throw new CostGovernanceError("Cost store exceeds its size limit.");
    try {
      return validateState(JSON.parse(source));
    } catch (error) {
      if (error instanceof CostGovernanceError) throw error;
      throw new CostGovernanceError("Cost store is not valid JSON.");
    }
  }

  private async mutate<T>(operation: (state: CostStoreState) => T): Promise<T> {
    return withFileLock(this.path, async () => {
      const state = await this.read();
      const result = operation(state);
      await atomicWriteJson(this.path, validateState(state));
      return result;
    });
  }
}

export function createDisabledCostOperatorAuthorizer(): CostOperatorAuthorizer {
  return { async authenticate(): Promise<never> { throw new CostGovernanceError("Cost operator authorization is not configured."); } };
}

export function createTestCostOperatorAuthorizer(): { authorizer: CostOperatorAuthorizer; issue(input: CostOperator): CostOperator } {
  const issued = new WeakSet<object>();
  return {
    authorizer: { async authenticate(identity: unknown): Promise<CostOperator> { if (identity === null || typeof identity !== "object" || !issued.has(identity)) throw new CostGovernanceError("Cost operator identity is not authenticated."); return validateOperator(identity); } },
    issue(input): CostOperator { const operator = Object.freeze(validateOperator(input)); issued.add(operator); return operator; }
  };
}

export function formatCostReport(report: CostReport): string {
  const lines = [`Cost report ${report.runId} at ${report.generatedAt}`];
  lines.push(`  window ${report.windowStart} -> ${report.windowEnd}`);
  lines.push(`  totals: requests=${report.totals.requests} messages=${report.totals.messages} mutations=${report.totals.mutations} tokenCost=${report.totals.tokenCost} monetaryAmountMinor=${report.totals.monetaryAmountMinor}`);
  for (const entry of report.attribution) {
    lines.push(`  by ${entry.dimension}:${entry.value} requests=${entry.totals.requests} tokenCost=${entry.totals.tokenCost} monetaryAmountMinor=${entry.totals.monetaryAmountMinor}`);
  }
  for (const budget of report.budgets) {
    const exceeded = budget.status === "exceeded" ? ` EXCEEDED (${budget.exceeded.map((entry) => `${entry.key} ${entry.total}/${entry.limit}`).join(", ")})` : "";
    lines.push(`  budget ${budget.id} ${budget.scope.dimension}:${budget.scope.value} ${budget.status}${exceeded}`);
  }
  lines.push(`  forecast: approximate linear extrapolation over ${report.forecast.sampleDays} day(s), next ${report.forecast.projectionDays} day(s) estimate requests=${report.forecast.nextPeriodEstimate.requests} tokenCost=${report.forecast.nextPeriodEstimate.tokenCost}`);
  lines.push(`  source: ${report.source}`);
  return lines.join("\n");
}

function emptyState(): CostStoreState {
  return { schemaVersion: 1, kind: "ghostapi.costs", records: [], budgets: [], alerts: [] };
}

function validateState(value: unknown): CostStoreState {
  const state = object(value, "Cost store must be an object.");
  exactKeys(state, ["schemaVersion", "kind", "records", "budgets", "alerts"], "Cost store");
  if (state.schemaVersion !== SCHEMA_VERSION || state.kind !== KIND) throw new CostGovernanceError("Unsupported cost store schema.");
  const records = array(state.records, "Cost records", MAX_RECORDS).map(validateRecord);
  unique(records.map((record) => record.recordId), "Cost record ids");
  const budgets = array(state.budgets, "Cost budgets", MAX_BUDGETS).map(validateBudget);
  unique(budgets.map((budget) => budget.id), "Cost budget ids");
  const alerts = array(state.alerts, "Cost alerts", MAX_ALERTS).map(validateAlert);
  unique(alerts.map((alert) => alert.id), "Cost alert ids");
  return { schemaVersion: 1, kind: "ghostapi.costs", records, budgets, alerts };
}

function validateRecordInput(input: RecordCostInput, now: string): CostRecord {
  const attribution = validateAttribution(input.attribution);
  const amounts = validateAmounts(input.amounts, "Cost record");
  return {
    schemaVersion: 1,
    kind: "ghostapi.cost-record",
    recordId: `record-${randomUUID().replace(/-/g, "").slice(0, 32)}`,
    tenantId: identifier(input.tenantId, "Cost tenant id"),
    runId: identifier(input.runId, "Cost run id"),
    actionId: identifier(input.actionId, "Cost action id"),
    recordedAt: now,
    attribution,
    amounts
  };
}

function validateRecord(value: unknown): CostRecord {
  const record = object(value, "Cost record is invalid.");
  exactKeys(record, ["schemaVersion", "kind", "recordId", "tenantId", "runId", "actionId", "recordedAt", "attribution", "amounts"], "Cost record");
  if (record.schemaVersion !== SCHEMA_VERSION || record.kind !== "ghostapi.cost-record") throw new CostGovernanceError("Unsupported cost record schema.");
  return {
    schemaVersion: 1,
    kind: "ghostapi.cost-record",
    recordId: identifier(record.recordId, "Cost record id"),
    tenantId: identifier(record.tenantId, "Cost tenant id"),
    runId: identifier(record.runId, "Cost run id"),
    actionId: identifier(record.actionId, "Cost action id"),
    recordedAt: timestamp(record.recordedAt, "Cost record time"),
    attribution: validateAttribution(record.attribution),
    amounts: validateAmounts(record.amounts, "Cost record")
  };
}

function validateBudget(value: unknown): CostBudget {
  const budget = object(value, "Cost budget is invalid.");
  exactKeys(budget, ["id", "scope", "windowMs", "limits", "alertOnExceed"], "Cost budget");
  const scope = object(budget.scope, "Cost budget scope is invalid.");
  exactKeys(scope, ["dimension", "value"], "Cost budget scope");
  if (!COST_DIMENSIONS.includes(scope.dimension as CostDimension)) throw new CostGovernanceError("Cost budget dimension is invalid.");
  const limits = validateLimits(budget.limits);
  if (typeof budget.alertOnExceed !== "boolean") throw new CostGovernanceError("Cost budget alertOnExceed flag is invalid.");
  return { id: identifier(budget.id, "Cost budget id"), scope: { dimension: scope.dimension as CostDimension, value: identifier(scope.value, "Cost budget scope value") }, windowMs: boundedMs(budget.windowMs, "Cost budget window"), limits, alertOnExceed: budget.alertOnExceed };
}

function validateAlert(value: unknown): CostAlert {
  const alert = object(value, "Cost alert is invalid.");
  exactKeys(alert, ["id", "budgetId", "scope", "windowMs", "windowStart", "windowEnd", "exceeded", "created", "status", "acknowledgedBy", "acknowledgedAt"], "Cost alert", ["acknowledgedBy", "acknowledgedAt"]);
  if (alert.status !== "open" && alert.status !== "acknowledged") throw new CostGovernanceError("Cost alert status is invalid.");
  const exceeded = array(alert.exceeded, "Cost alert exceeded entries", COST_AMOUNT_KEYS.length).map((entry) => {
    const value = object(entry, "Cost alert exceeded entry is invalid.");
    exactKeys(value, ["key", "limit", "total"], "Cost alert exceeded entry");
    if (!COST_AMOUNT_KEYS.includes(value.key as CostAmountKey)) throw new CostGovernanceError("Cost alert exceeded key is invalid.");
    return { key: value.key as CostAmountKey, limit: nonNegative(value.limit, "Cost alert limit", Number.MAX_SAFE_INTEGER), total: nonNegative(value.total, "Cost alert total", Number.MAX_SAFE_INTEGER) };
  });
  const scope = object(alert.scope, "Cost alert scope is invalid.");
  exactKeys(scope, ["dimension", "value"], "Cost alert scope");
  if (!COST_DIMENSIONS.includes(scope.dimension as CostDimension)) throw new CostGovernanceError("Cost alert dimension is invalid.");
  const result: CostAlert = {
    id: identifier(alert.id, "Cost alert id"),
    budgetId: identifier(alert.budgetId, "Cost budget id"),
    scope: { dimension: scope.dimension as CostDimension, value: identifier(scope.value, "Cost alert scope value") },
    windowMs: boundedMs(alert.windowMs, "Cost alert window"),
    windowStart: timestamp(alert.windowStart, "Cost alert window start"),
    windowEnd: timestamp(alert.windowEnd, "Cost alert window end"),
    exceeded,
    created: timestamp(alert.created, "Cost alert creation time"),
    status: alert.status,
    ...(alert.acknowledgedBy === undefined ? {} : { acknowledgedBy: identifier(alert.acknowledgedBy, "Cost alert operator") }),
    ...(alert.acknowledgedAt === undefined ? {} : { acknowledgedAt: timestamp(alert.acknowledgedAt, "Cost alert acknowledgement time") })
  };
  if (result.status === "acknowledged" && (result.acknowledgedBy === undefined || result.acknowledgedAt === undefined)) throw new CostGovernanceError("Acknowledged cost alerts require audit metadata.");
  if (result.status === "open" && result.acknowledgedBy !== undefined) throw new CostGovernanceError("Open cost alerts cannot carry acknowledgement metadata.");
  return result;
}

function validateAttribution(value: unknown): CostAttribution {
  const attribution = object(value, "Cost attribution is invalid.");
  exactKeys(attribution, ["agentId", "projectId", "provider", "actionClass", "workflowId"], "Cost attribution");
  return {
    agentId: identifier(attribution.agentId, "Cost agent id"),
    projectId: identifier(attribution.projectId, "Cost project id"),
    provider: identifier(attribution.provider, "Cost provider"),
    actionClass: identifier(attribution.actionClass, "Cost action class"),
    workflowId: identifier(attribution.workflowId, "Cost workflow id")
  };
}

function validateAmounts(value: unknown, label: string): CostAmounts {
  const amounts = object(value, `${label} amounts are invalid.`);
  exactKeys(amounts, [...COST_AMOUNT_KEYS], label);
  return {
    monetaryAmountMinor: nonNegative(amounts.monetaryAmountMinor, `${label} monetary amount`, Number.MAX_SAFE_INTEGER),
    requests: nonNegative(amounts.requests, `${label} requests`, Number.MAX_SAFE_INTEGER),
    messages: nonNegative(amounts.messages, `${label} messages`, Number.MAX_SAFE_INTEGER),
    mutations: nonNegative(amounts.mutations, `${label} mutations`, Number.MAX_SAFE_INTEGER),
    deletes: nonNegative(amounts.deletes, `${label} deletes`, Number.MAX_SAFE_INTEGER),
    tokenCost: nonNegative(amounts.tokenCost, `${label} token cost`, Number.MAX_SAFE_INTEGER)
  };
}

function validateLimits(value: unknown): Partial<Record<CostAmountKey, number>> {
  const limits = object(value, "Cost budget limits are invalid.");
  exactKeys(limits, [...COST_AMOUNT_KEYS], "Cost budget limits");
  const parsed: Partial<Record<CostAmountKey, number>> = {};
  for (const key of COST_AMOUNT_KEYS) if (limits[key] !== undefined) parsed[key] = nonNegative(limits[key], `Cost budget ${key}`, Number.MAX_SAFE_INTEGER);
  if (Object.keys(parsed).length === 0) throw new CostGovernanceError("Cost budget requires at least one limit.");
  return parsed;
}

function evaluateBudget(budget: CostBudget, records: CostRecord[], now: string): CostBudgetEvaluation {
  const windowStart = Date.parse(now) - budget.windowMs;
  const inWindow = records.filter((record) => Date.parse(record.recordedAt) >= windowStart && record.attribution[ATTRIBUTION_DIMENSION_KEY[budget.scope.dimension]] === budget.scope.value);
  const totals = sumAmounts(inWindow.map((record) => record.amounts));
  const exceeded: Array<{ key: CostAmountKey; limit: number; total: number }> = [];
  for (const key of COST_AMOUNT_KEYS) {
    if (budget.limits[key] !== undefined && totals[key] > budget.limits[key]!) exceeded.push({ key, limit: budget.limits[key]!, total: totals[key] });
  }
  return { id: budget.id, scope: budget.scope, windowMs: budget.windowMs, limits: budget.limits, totals, status: exceeded.length === 0 ? "within" : "exceeded", exceeded };
}

function tenantScoped(records: CostRecord[], tenantId: string | undefined): CostRecord[] {
  return tenantId === undefined ? records : records.filter((record) => record.tenantId === tenantId);
}

function deriveAlerts(existing: CostAlert[], evaluations: CostBudgetEvaluation[], budgets: CostBudget[], now: string): CostAlert[] {
  if (evaluations.every((evaluation) => evaluation.status === "within")) return existing;
  const alerts = [...existing];
  for (const evaluation of evaluations) {
    if (evaluation.status !== "exceeded") continue;
    const budget = budgets.find((candidate) => candidate.id === evaluation.id);
    if (budget !== undefined && !budget.alertOnExceed) continue;
    const current = alerts.find((candidate) => candidate.budgetId === evaluation.id && candidate.status === "open");
    const payload = { budgetId: evaluation.id, scope: evaluation.scope, windowMs: evaluation.windowMs, windowStart: new Date(Date.parse(now) - evaluation.windowMs).toISOString(), windowEnd: now, exceeded: evaluation.exceeded };
    if (current !== undefined) {
      Object.assign(current, payload);
    } else {
      if (alerts.length >= MAX_ALERTS) {
        const removable = alerts.findIndex((candidate) => candidate.status === "acknowledged");
        if (removable === -1) throw new CostGovernanceError("Cost alert limit was reached.");
        alerts.splice(removable, 1);
      }
      alerts.push({ id: `alert-${randomUUID().replace(/-/g, "").slice(0, 32)}`, ...payload, created: now, status: "open" });
    }
  }
  return alerts;
}

function aggregateAttribution(records: CostRecord[]): Array<{ dimension: CostDimension; value: string; totals: CostAmounts }> {
  const result: Array<{ dimension: CostDimension; value: string; totals: CostAmounts }> = [];
  for (const dimension of COST_DIMENSIONS) {
    const byValue = new Map<string, CostAmounts>();
    for (const record of records) {
      const value = record.attribution[ATTRIBUTION_DIMENSION_KEY[dimension]];
      const current = byValue.get(value) ?? zeroAmounts();
      byValue.set(value, addAmounts(current, record.amounts));
    }
    for (const [value, totals] of byValue) result.push({ dimension, value, totals });
  }
  return result;
}

function buildForecast(records: CostRecord[], projectionDays: number, now: string, windowMs: number): CostForecast {
  const sampleStartMs = Date.parse(now) - Math.min(windowMs, 30 * 24 * 60 * 60 * 1000);
  const byDay = new Map<string, CostAmounts>();
  for (const record of records) {
    const recordedAt = Date.parse(record.recordedAt);
    if (recordedAt < sampleStartMs) continue;
    const day = new Date(recordedAt).toISOString().slice(0, 10);
    byDay.set(day, addAmounts(byDay.get(day) ?? zeroAmounts(), record.amounts));
  }
  const days = [...byDay.keys()].sort();
  const sampleStart = days[0] ?? now;
  const sampleEnd = days.at(-1) ?? now;
  const averagePerDay = zeroAmounts();
  const trendPerDay = zeroAmounts();
  if (days.length >= 2) {
    const points = days.map((day, index) => ({ x: index, totals: byDay.get(day)! }));
    for (const key of COST_AMOUNT_KEYS) {
      const values = points.map((point) => ({ x: point.x, y: point.totals[key] }));
      const slope = linearSlope(values);
      trendPerDay[key] = Math.max(0, Math.round(slope));
      averagePerDay[key] = Math.round(points.reduce((sum, point) => sum + point.totals[key], 0) / points.length);
    }
  } else if (days.length === 1) {
    const totals = byDay.get(days[0]!)!;
    for (const key of COST_AMOUNT_KEYS) {
      averagePerDay[key] = totals[key];
      trendPerDay[key] = 0;
    }
  }
  const nextPeriodEstimate: CostAmounts = { ...zeroAmounts() };
  for (const key of COST_AMOUNT_KEYS) nextPeriodEstimate[key] = Math.max(0, averagePerDay[key] * projectionDays);
  return {
    method: "linear-extrapolation",
    approximation: true,
    projectionDays,
    sampleDays: days.length,
    sampleStart,
    sampleEnd,
    averagePerDay,
    trendPerDay,
    nextPeriodEstimate,
    disclaimer: "This forecast is an explainable linear approximation of local synthetic cost metadata. It is not a provider invoice, not a commitment, and not a prediction of real billing; calibrate it against provider billing during the pilot."
  };
}

function linearSlope(values: Array<{ x: number; y: number }>): number {
  const n = values.length;
  if (n < 2) return 0;
  const sumX = values.reduce((sum, point) => sum + point.x, 0);
  const sumY = values.reduce((sum, point) => sum + point.y, 0);
  const sumXy = values.reduce((sum, point) => sum + point.x * point.y, 0);
  const sumXx = values.reduce((sum, point) => sum + point.x * point.x, 0);
  const denominator = n * sumXx - sumX * sumX;
  if (denominator === 0) return 0;
  return (n * sumXy - sumX * sumY) / denominator;
}

function zeroAmounts(): CostAmounts {
  return { monetaryAmountMinor: 0, requests: 0, messages: 0, mutations: 0, deletes: 0, tokenCost: 0 };
}

function addAmounts(left: CostAmounts, right: CostAmounts): CostAmounts {
  return { monetaryAmountMinor: left.monetaryAmountMinor + right.monetaryAmountMinor, requests: left.requests + right.requests, messages: left.messages + right.messages, mutations: left.mutations + right.mutations, deletes: left.deletes + right.deletes, tokenCost: left.tokenCost + right.tokenCost };
}

function sumAmounts(values: CostAmounts[]): CostAmounts {
  return values.reduce(addAmounts, zeroAmounts());
}

function validateOperator(value: unknown): CostOperator {
  const operator = object(value, "Cost operator is invalid.");
  exactKeys(operator, ["id", "principalId", "permissions", "tenantId"], "Cost operator", ["tenantId"]);
  const permissions = array(operator.permissions, "Cost operator permissions", 8).map((permission) => {
    if (permission !== "cost.record" && permission !== "cost.configure" && permission !== "cost.inspect" && permission !== "cost.acknowledge") throw new CostGovernanceError("Cost operator permission is invalid.");
    return permission as CostOperatorPermission;
  });
  unique(permissions, "Cost operator permissions");
  return { id: identifier(operator.id, "Cost operator id"), principalId: identifier(operator.principalId, "Cost operator principal id"), permissions, ...(operator.tenantId === undefined ? {} : { tenantId: identifier(operator.tenantId, "Cost operator tenant id") }) };
}

function boundedMs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 60 * 60 * 1000 || value > MAX_WINDOW_MS) throw new CostGovernanceError(`${label} must be between one hour and 90 days.`);
  return value;
}

function boundedDays(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 30) throw new CostGovernanceError(`${label} must be from 1 through 30 days.`);
  return value;
}

function nonNegative(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new CostGovernanceError(`${label} is invalid.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || sanitizeSecretString(value) !== value) throw new CostGovernanceError(`${label} must be a safe identifier.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new CostGovernanceError(`${label} must be an ISO UTC timestamp.`);
  return value;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CostGovernanceError(message);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new CostGovernanceError(`${label} is invalid.`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string, optional: string[] = []): void {
  for (const key of Object.keys(value)) if (!keys.includes(key) || (value[key] === undefined && !optional.includes(key))) throw new CostGovernanceError(`${label} contains unsupported field: ${key}`);
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new CostGovernanceError(`${label} must be unique.`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}