import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import type { LedgerEntry, LocalActionLedger } from "../ledger/index.js";
import { sanitizeSecretString } from "../security/secrets.js";
import {
  atomicWriteJson,
  ensurePrivateDirectory,
  withFileLock,
} from "../storage/fileStore.js";
import { inspectWorld, SyntheticWorldError } from "../worlds/index.js";
import {
  createSloRecordIdentity,
  type LocalSloController,
  type SloMetric,
} from "./slo.js";

const SCHEMA_VERSION = 1;
const KIND = "ghostapi.reconciliation";
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_FINDINGS = 1_000;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

export const RECONCILIATION_OUTCOMES = [
  "committed",
  "not_committed",
  "unknown",
  "compensated",
  "drifted",
] as const;
export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number];

export type ReconciliationLedgerIntent =
  | "committed"
  | "committed_unverified"
  | "ambiguous"
  | "failed"
  | "attempted"
  | "compensated"
  | "not_committed";

export type ReconciliationProviderState = {
  receipts: ReadonlyArray<{ actionId: string }>;
};
export type ReconciliationProvider = {
  resolveWorld(input: {
    actionId: string;
    actionHash: string;
  }): Promise<string | null>;
  read(input: { worldId: string }): Promise<ReconciliationProviderState | null>;
};

export type ReconciliationActionResult = {
  tenantId: string;
  actionId: string;
  actionHash: string;
  ledgerIntent: ReconciliationLedgerIntent;
  providerWorldId: string | null;
  providerPresent: boolean | null;
  outcome: ReconciliationOutcome;
  retrySafe: boolean;
  reconciledFromProvider: boolean;
  reasons: string[];
};

export type ReconciliationSli = {
  duplicatePrevention: { measured: number; ok: number; okRateBps: number };
  receiptVerification: { measured: number; ok: number; okRateBps: number };
  availability: { measured: number; ok: number; okRateBps: number };
  executionLatency: {
    measured: number;
    avgMs: number;
    p95Ms: number;
    p99Ms: number;
    basis: "ledger_record_interval";
  };
};

export type ReconciliationReport = {
  schemaVersion: 1;
  kind: "ghostapi.reconciliation-report";
  runId: string;
  tenantId: string;
  ranAt: string;
  integrity: "valid";
  actions: ReconciliationActionResult[];
  counts: Record<ReconciliationOutcome, number>;
  sli: ReconciliationSli;
  findingsOpened: number;
};

export type ReconciliationFinding = {
  schemaVersion: 1;
  kind: "ghostapi.reconciliation-finding";
  findingId: string;
  tenantId: string;
  actionId: string;
  actionHash: string;
  classification: "drifted" | "unknown";
  detail: string;
  detectedAt: string;
  status: "open" | "resolved";
  resolution?: {
    resolvedAt: string;
    resolvedBy: string;
    reason: string;
    evidenceRef?: string;
  };
};

export type ReconciliationState = {
  schemaVersion: 1;
  kind: "ghostapi.reconciliation";
  lastRun: {
    runId: string;
    ranAt: string;
    counts: Record<ReconciliationOutcome, number>;
  } | null;
  findings: ReconciliationFinding[];
};

export type ReconciliationOperatorPermission =
  "reconciliation.manage" | "reconciliation.inspect";
export type ReconciliationOperator = {
  id: string;
  principalId: string;
  permissions: readonly ReconciliationOperatorPermission[];
};
export interface ReconciliationOperatorAuthorizer {
  authenticate(identity: unknown): Promise<ReconciliationOperator>;
}

export type ReconciliationServiceOptions = {
  path?: string;
  now?: () => Date;
  ledger: LocalActionLedger;
  capability: object;
  provider: ReconciliationProvider;
  sloController?: LocalSloController;
  operatorAuthorizer?: ReconciliationOperatorAuthorizer;
};

export class ReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationError";
  }
}

export function createLocalReconciliationService(
  options: ReconciliationServiceOptions,
): LocalReconciliationService {
  return new LocalReconciliationService(options);
}

export class LocalReconciliationService {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly ledger: LocalActionLedger;
  private readonly capability: object;
  private readonly provider: ReconciliationProvider;
  private readonly sloController: LocalSloController | undefined;
  private readonly sloRecordIdentity: object;
  private readonly operatorAuthorizer: ReconciliationOperatorAuthorizer;

  constructor(options: ReconciliationServiceOptions) {
    this.path = options.path ?? getDataPaths().reconciliationStore;
    this.now = options.now ?? (() => new Date());
    this.ledger = options.ledger;
    this.capability = options.capability;
    this.provider = options.provider;
    this.sloController = options.sloController;
    this.sloRecordIdentity = createSloRecordIdentity();
    this.operatorAuthorizer =
      options.operatorAuthorizer ??
      createDisabledReconciliationOperatorAuthorizer();
  }

  async runReconciliation(input: {
    identity: unknown;
  }): Promise<ReconciliationReport> {
    await this.authorize(input.identity, "reconciliation.manage");
    const runId = `recon-${randomUUID().replace(/-/g, "").slice(0, 32)}`;
    const now = this.timestamp();
    let exportResult;
    try {
      exportResult = await this.ledger.exportTenant(this.capability);
    } catch (error) {
      throw new ReconciliationError(
        `Reconciliation is blocked because the tenant ledger failed integrity verification: ${error instanceof Error ? error.message : "unknown ledger error"}`,
      );
    }
    const tenantId = exportResult.tenantId;
    const timelines = groupByAction(exportResult.entries);
    const results: ReconciliationActionResult[] = [];
    const measurements: Array<{
      executed: boolean;
      duplicateOk: boolean;
      verificationOk: boolean | null;
      availabilityOk: boolean;
      latencyMs: number | null;
    }> = [];

    for (const actionId of Object.keys(timelines).sort()) {
      const timeline = timelines[actionId]!;
      const result = await this.classify(tenantId, actionId, timeline);
      results.push(result);
      measurements.push(measureAction(timeline, result.outcome));
    }

    const counts = countOutcomes(results);
    const sli = aggregateSli(results, measurements);
    const findingsOpened = await this.mutate((state) => {
      state.lastRun = { runId, ranAt: now, counts };
      let opened = 0;
      for (const result of results) {
        if (result.outcome === "drifted" || result.outcome === "unknown") {
          const alreadyOpen = state.findings.some(
            (finding) =>
              finding.actionHash === result.actionHash &&
              finding.status === "open",
          );
          if (!alreadyOpen) {
            if (state.findings.length >= MAX_FINDINGS)
              throw new ReconciliationError(
                "Reconciliation findings limit was reached.",
              );
            state.findings.push(makeFinding(result, now));
            opened += 1;
          }
        }
      }
      return opened;
    });

    if (this.sloController !== undefined) {
      const samples: Array<{
        metric: SloMetric;
        ok: boolean;
        durationMs?: number;
        runId: string;
        actionId: string;
        labels: { tenantId: string };
      }> = [];
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]!;
        const measurement = measurements[index]!;
        if (!measurement.executed) continue;
        samples.push({
          metric: "duplicate_prevention",
          ok: measurement.duplicateOk,
          runId,
          actionId: result.actionId,
          labels: { tenantId },
        });
        samples.push({
          metric: "availability",
          ok: measurement.availabilityOk,
          runId,
          actionId: result.actionId,
          labels: { tenantId },
        });
        if (measurement.verificationOk !== null)
          samples.push({
            metric: "receipt_verification",
            ok: measurement.verificationOk,
            runId,
            actionId: result.actionId,
            labels: { tenantId },
          });
        if (measurement.latencyMs !== null)
          samples.push({
            metric: "execution_latency",
            ok: true,
            durationMs: measurement.latencyMs,
            runId,
            actionId: result.actionId,
            labels: { tenantId },
          });
      }
      if (samples.length > 0)
        await this.sloController.recordSamples(samples, this.sloRecordIdentity);
    }

    return {
      schemaVersion: 1,
      kind: "ghostapi.reconciliation-report",
      runId,
      tenantId,
      ranAt: now,
      integrity: "valid",
      actions: results,
      counts,
      sli,
      findingsOpened,
    };
  }

  async listFindings(input: {
    identity: unknown;
  }): Promise<ReconciliationFinding[]> {
    await this.authorize(input.identity, "reconciliation.inspect");
    const state = await this.read();
    return clone(state.findings);
  }

  async resolveDrift(input: {
    identity: unknown;
    findingId: string;
    reason: string;
  }): Promise<ReconciliationFinding> {
    const operator = await this.authorize(
      input.identity,
      "reconciliation.manage",
    );
    const findingId = identifier(input.findingId, "Reconciliation finding id");
    const reason = text(input.reason, "Reconciliation resolution reason", 300);
    return this.mutate((state) => {
      const finding = findFinding(state, findingId);
      if (finding.classification !== "drifted")
        throw new ReconciliationError(
          "Only drifted findings can be resolved with a drift resolution reason.",
        );
      if (finding.status === "resolved")
        throw new ReconciliationError(
          "Reconciliation finding is already resolved.",
        );
      finding.status = "resolved";
      finding.resolution = {
        resolvedAt: this.timestamp(),
        resolvedBy: operator.principalId,
        reason,
      };
      return clone(finding);
    });
  }

  async resolveUnknown(input: {
    identity: unknown;
    findingId: string;
    reason: string;
    evidenceRef: string;
  }): Promise<ReconciliationFinding> {
    const operator = await this.authorize(
      input.identity,
      "reconciliation.manage",
    );
    const findingId = identifier(input.findingId, "Reconciliation finding id");
    const reason = text(input.reason, "Reconciliation resolution reason", 300);
    const evidenceRef = evidence(
      input.evidenceRef,
      "Reconciliation evidence reference",
    );
    return this.mutate((state) => {
      const finding = findFinding(state, findingId);
      if (finding.classification !== "unknown")
        throw new ReconciliationError(
          "Only unknown findings can be resolved with provider evidence.",
        );
      if (finding.status === "resolved")
        throw new ReconciliationError(
          "Reconciliation finding is already resolved.",
        );
      finding.status = "resolved";
      finding.resolution = {
        resolvedAt: this.timestamp(),
        resolvedBy: operator.principalId,
        reason,
        evidenceRef,
      };
      return clone(finding);
    });
  }

  private async classify(
    tenantId: string,
    actionId: string,
    timeline: LedgerEntry[],
  ): Promise<ReconciliationActionResult> {
    const actionHash = timeline[0]!.actionHash;
    const intent = classifyIntent(timeline);
    const reasons = intentReasons(intent);
    const worldId = await this.provider.resolveWorld({ actionId, actionHash });
    let providerPresent: boolean | null = null;
    if (worldId !== null) {
      const world = await this.provider.read({ worldId });
      providerPresent =
        world !== null &&
        world.receipts.some((receipt) => receipt.actionId === actionId);
    }
    const decided = decideOutcome(intent, providerPresent);
    if (providerPresent === null)
      reasons.push("provider state could not be inspected for this action");
    if (decided.reconciledFromProvider)
      reasons.push(
        "ledger outcome was incomplete; provider evidence confirms the commitment",
      );
    if (decided.outcome === "drifted")
      reasons.push(
        providerPresent
          ? "provider has a receipt the ledger does not record"
          : "ledger records a commitment the provider does not confirm",
      );
    return {
      tenantId,
      actionId,
      actionHash,
      ledgerIntent: intent,
      providerWorldId: worldId,
      providerPresent,
      outcome: decided.outcome,
      retrySafe: decided.retrySafe,
      reconciledFromProvider: decided.reconciledFromProvider,
      reasons,
    };
  }

  private async authorize(
    identity: unknown,
    permission: ReconciliationOperatorPermission,
  ): Promise<ReconciliationOperator> {
    const operator = validateOperator(
      await this.operatorAuthorizer.authenticate(identity),
    );
    if (!operator.permissions.includes(permission))
      throw new ReconciliationError(
        `Reconciliation operator lacks required permission: ${permission}.`,
      );
    return operator;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      throw new ReconciliationError("Reconciliation clock is invalid.");
    return value.toISOString();
  }

  private async read(): Promise<ReconciliationState> {
    await ensurePrivateDirectory(dirname(this.path));
    const info = await lstat(this.path).catch((error: unknown) =>
      isErrorCode(error, "ENOENT") ? null : Promise.reject(error),
    );
    if (info === null) return emptyState();
    if (!info.isFile() || info.isSymbolicLink())
      throw new ReconciliationError(
        "Reconciliation store must be a regular non-symlink file.",
      );
    const source = await readFile(this.path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_STORE_BYTES)
      throw new ReconciliationError(
        "Reconciliation store exceeds its size limit.",
      );
    try {
      return validateState(JSON.parse(source));
    } catch (error) {
      if (error instanceof ReconciliationError) throw error;
      throw new ReconciliationError("Reconciliation store is not valid JSON.");
    }
  }

  private async mutate<T>(
    operation: (state: ReconciliationState) => T,
  ): Promise<T> {
    return withFileLock(this.path, async () => {
      const state = await this.read();
      const result = operation(state);
      await atomicWriteJson(this.path, validateState(state));
      return result;
    });
  }
}

export function createDisabledReconciliationOperatorAuthorizer(): ReconciliationOperatorAuthorizer {
  return {
    async authenticate(): Promise<never> {
      throw new ReconciliationError(
        "Reconciliation operator authorization is not configured.",
      );
    },
  };
}

export function createTestReconciliationOperatorAuthorizer(): {
  authorizer: ReconciliationOperatorAuthorizer;
  issue(input: ReconciliationOperator): ReconciliationOperator;
} {
  const issued = new WeakSet<object>();
  return {
    authorizer: {
      async authenticate(identity: unknown): Promise<ReconciliationOperator> {
        if (
          identity === null ||
          typeof identity !== "object" ||
          !issued.has(identity)
        )
          throw new ReconciliationError(
            "Reconciliation operator identity is not authenticated.",
          );
        return validateOperator(identity);
      },
    },
    issue(input): ReconciliationOperator {
      const operator = Object.freeze(validateOperator(input));
      issued.add(operator);
      return operator;
    },
  };
}

export function createWorldStateReconciliationProvider(
  resolveWorld: (
    actionId: string,
    actionHash: string,
  ) => Promise<string | null>,
): ReconciliationProvider {
  return {
    async resolveWorld(input) {
      return resolveWorld(input.actionId, input.actionHash);
    },
    async read(input) {
      try {
        const world = await inspectWorld(input.worldId);
        return {
          receipts: world.state.receipts.map((receipt) => ({
            actionId: receipt.actionId,
          })),
        };
      } catch (error) {
        if (
          error instanceof SyntheticWorldError &&
          error.code === "WORLD_NOT_FOUND"
        )
          return null;
        throw error;
      }
    },
  };
}

export function formatReconciliationReport(
  report: ReconciliationReport,
): string {
  const lines = [
    `Reconciliation run ${report.runId} for tenant ${report.tenantId} at ${report.ranAt}`,
  ];
  lines.push(`  ledger integrity: ${report.integrity}`);
  lines.push(
    `  outcomes: committed=${report.counts.committed} not_committed=${report.counts.not_committed} unknown=${report.counts.unknown} compensated=${report.counts.compensated} drifted=${report.counts.drifted}`,
  );
  lines.push(`  findings opened: ${report.findingsOpened}`);
  lines.push(
    `  duplicate_prevention ok ${report.sli.duplicatePrevention.ok}/${report.sli.duplicatePrevention.measured} (${report.sli.duplicatePrevention.okRateBps} bps)`,
  );
  lines.push(
    `  receipt_verification ok ${report.sli.receiptVerification.ok}/${report.sli.receiptVerification.measured} (${report.sli.receiptVerification.okRateBps} bps)`,
  );
  lines.push(
    `  availability ok ${report.sli.availability.ok}/${report.sli.availability.measured} (${report.sli.availability.okRateBps} bps)`,
  );
  lines.push(
    `  execution_latency avg ${Math.round(report.sli.executionLatency.avgMs)}ms p95 ${Math.round(report.sli.executionLatency.p95Ms)}ms p99 ${Math.round(report.sli.executionLatency.p99Ms)}ms`,
  );
  for (const action of report.actions) {
    if (action.outcome === "drifted" || action.outcome === "unknown") {
      lines.push(
        `  ${action.outcome}: ${action.actionId} (${action.ledgerIntent}) provider=${action.providerPresent === null ? "unresolved" : action.providerPresent} ${action.reasons.join("; ")}`,
      );
    }
  }
  return lines.join("\n");
}

function classifyIntent(timeline: LedgerEntry[]): ReconciliationLedgerIntent {
  const compensation = lastEntry(timeline, "compensation");
  if (compensation?.data.status === "attempted") return "compensated";
  const providerReceipts = entries(timeline, "provider_receipt");
  const verifications = entries(timeline, "verification");
  const attempts = entries(timeline, "execution_attempt");
  if (providerReceipts.length > 0) {
    const verification = verifications.at(-1);
    if (verification?.data.status === "verified") return "committed";
    return "committed_unverified";
  }
  const attempt = attempts.at(-1);
  if (attempt !== undefined) {
    if (attempt.data.status === "ambiguous") return "ambiguous";
    if (attempt.data.status === "failed") return "failed";
    return "attempted";
  }
  return "not_committed";
}

function decideOutcome(
  intent: ReconciliationLedgerIntent,
  providerPresent: boolean | null,
): {
  outcome: ReconciliationOutcome;
  retrySafe: boolean;
  reconciledFromProvider: boolean;
} {
  switch (intent) {
    case "committed":
      if (providerPresent === true)
        return {
          outcome: "committed",
          retrySafe: false,
          reconciledFromProvider: false,
        };
      if (providerPresent === false)
        return {
          outcome: "drifted",
          retrySafe: false,
          reconciledFromProvider: false,
        };
      return {
        outcome: "unknown",
        retrySafe: false,
        reconciledFromProvider: false,
      };
    case "committed_unverified":
    case "ambiguous":
    case "failed":
    case "attempted":
      if (providerPresent === true)
        return {
          outcome: "committed",
          retrySafe: false,
          reconciledFromProvider: true,
        };
      return {
        outcome: "unknown",
        retrySafe: false,
        reconciledFromProvider: false,
      };
    case "not_committed":
      if (providerPresent === true)
        return {
          outcome: "drifted",
          retrySafe: false,
          reconciledFromProvider: false,
        };
      if (providerPresent === false)
        return {
          outcome: "not_committed",
          retrySafe: true,
          reconciledFromProvider: false,
        };
      return {
        outcome: "unknown",
        retrySafe: false,
        reconciledFromProvider: false,
      };
    case "compensated":
      return {
        outcome: "compensated",
        retrySafe: false,
        reconciledFromProvider: false,
      };
  }
}

function intentReasons(intent: ReconciliationLedgerIntent): string[] {
  switch (intent) {
    case "committed":
      return ["ledger shows a verified provider receipt"];
    case "committed_unverified":
      return ["ledger records a provider receipt without a verified proof"];
    case "ambiguous":
      return ["ledger records an ambiguous execution outcome"];
    case "failed":
      return ["ledger records a failed execution outcome"];
    case "attempted":
      return ["ledger records an execution attempt without a receipt"];
    case "not_committed":
      return ["ledger never reached the provider"];
    case "compensated":
      return ["ledger records an attempted compensation"];
  }
}

function measureAction(
  timeline: LedgerEntry[],
  outcome: ReconciliationOutcome,
): {
  executed: boolean;
  duplicateOk: boolean;
  verificationOk: boolean | null;
  availabilityOk: boolean;
  latencyMs: number | null;
} {
  const providerReceipts = entries(timeline, "provider_receipt");
  const verifications = entries(timeline, "verification");
  const attempts = entries(timeline, "execution_attempt");
  const executed = attempts.length > 0 || providerReceipts.length > 0;
  const duplicateOk = providerReceipts.length <= 1 && verifications.length <= 1;
  const verificationOk =
    providerReceipts.length === 0
      ? null
      : verifications.at(-1)?.data.status === "verified";
  const availabilityOk = !executed
    ? false
    : outcome === "committed" ||
      outcome === "not_committed" ||
      outcome === "compensated";
  const receipt = providerReceipts[0];
  const proof = verifications.at(-1);
  const latencyMs =
    receipt !== undefined && proof !== undefined
      ? Math.max(0, Date.parse(proof.timestamp) - Date.parse(receipt.timestamp))
      : null;
  return { executed, duplicateOk, verificationOk, availabilityOk, latencyMs };
}

function aggregateSli(
  results: ReconciliationActionResult[],
  measurements: Array<{
    executed: boolean;
    duplicateOk: boolean;
    verificationOk: boolean | null;
    availabilityOk: boolean;
    latencyMs: number | null;
  }>,
): ReconciliationSli {
  const duplicatePrevention = { measured: 0, ok: 0 };
  const receiptVerification = { measured: 0, ok: 0 };
  const availability = { measured: 0, ok: 0 };
  const latencies: number[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const measurement = measurements[index]!;
    if (measurement.executed) {
      duplicatePrevention.measured += 1;
      if (measurement.duplicateOk) duplicatePrevention.ok += 1;
      availability.measured += 1;
      if (measurement.availabilityOk) availability.ok += 1;
    }
    if (measurement.verificationOk !== null) {
      receiptVerification.measured += 1;
      if (measurement.verificationOk) receiptVerification.ok += 1;
    }
    if (measurement.latencyMs !== null) latencies.push(measurement.latencyMs);
  }
  const ordered = [...latencies].sort((left, right) => left - right);
  const percentile = (value: number): number =>
    ordered.length === 0
      ? 0
      : ordered[
          Math.min(
            ordered.length - 1,
            Math.max(0, Math.ceil((value / 100) * ordered.length) - 1),
          )
        ]!;
  return {
    duplicatePrevention: {
      ...duplicatePrevention,
      okRateBps: rateBps(duplicatePrevention.ok, duplicatePrevention.measured),
    },
    receiptVerification: {
      ...receiptVerification,
      okRateBps: rateBps(receiptVerification.ok, receiptVerification.measured),
    },
    availability: {
      ...availability,
      okRateBps: rateBps(availability.ok, availability.measured),
    },
    executionLatency: {
      measured: latencies.length,
      avgMs:
        latencies.length === 0
          ? 0
          : latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
      p95Ms: percentile(95),
      p99Ms: percentile(99),
      basis: "ledger_record_interval",
    },
  };
}

function countOutcomes(
  results: ReconciliationActionResult[],
): Record<ReconciliationOutcome, number> {
  const counts: Record<ReconciliationOutcome, number> = {
    committed: 0,
    not_committed: 0,
    unknown: 0,
    compensated: 0,
    drifted: 0,
  };
  for (const result of results) counts[result.outcome] += 1;
  return counts;
}

function makeFinding(
  result: ReconciliationActionResult,
  now: string,
): ReconciliationFinding {
  const classification = result.outcome === "drifted" ? "drifted" : "unknown";
  return {
    schemaVersion: 1,
    kind: "ghostapi.reconciliation-finding",
    findingId: `finding-${randomUUID().replace(/-/g, "").slice(0, 32)}`,
    tenantId: result.tenantId,
    actionId: result.actionId,
    actionHash: result.actionHash,
    classification,
    detail: result.reasons.join("; "),
    detectedAt: now,
    status: "open",
  };
}

function groupByAction(
  entries: readonly LedgerEntry[],
): Record<string, LedgerEntry[]> {
  const groups: Record<string, LedgerEntry[]> = {};
  for (const entry of entries) {
    if (entry.actionId.startsWith("governance-")) continue;
    (groups[entry.actionId] ??= []).push(entry);
  }
  return groups;
}

function entries(timeline: LedgerEntry[], stage: string): LedgerEntry[] {
  return timeline.filter((entry) => entry.stage === stage);
}

function lastEntry(
  timeline: LedgerEntry[],
  stage: string,
): LedgerEntry | undefined {
  return entries(timeline, stage).at(-1);
}

function emptyState(): ReconciliationState {
  return {
    schemaVersion: 1,
    kind: "ghostapi.reconciliation",
    lastRun: null,
    findings: [],
  };
}

function validateState(value: unknown): ReconciliationState {
  const state = object(value, "Reconciliation store must be an object.");
  exactKeys(
    state,
    ["schemaVersion", "kind", "lastRun", "findings"],
    "Reconciliation store",
  );
  if (state.schemaVersion !== SCHEMA_VERSION || state.kind !== KIND)
    throw new ReconciliationError("Unsupported reconciliation store schema.");
  const findings = array(
    state.findings,
    "Reconciliation findings",
    MAX_FINDINGS,
  ).map(validateFinding);
  unique(
    findings.map((finding) => finding.findingId),
    "Reconciliation finding ids",
  );
  let lastRun = null;
  if (state.lastRun !== null) {
    const run = object(state.lastRun, "Reconciliation last run is invalid.");
    exactKeys(run, ["runId", "ranAt", "counts"], "Reconciliation last run");
    const counts = object(
      run.counts,
      "Reconciliation outcome counts are invalid.",
    );
    for (const outcome of RECONCILIATION_OUTCOMES) {
      if (
        typeof counts[outcome] !== "number" ||
        !Number.isInteger(counts[outcome] as number) ||
        (counts[outcome] as number) < 0
      )
        throw new ReconciliationError(
          "Reconciliation outcome counts are invalid.",
        );
    }
    lastRun = {
      runId: identifier(run.runId, "Reconciliation run id"),
      ranAt: timestamp(run.ranAt, "Reconciliation run time"),
      counts: counts as Record<ReconciliationOutcome, number>,
    };
  }
  return {
    schemaVersion: 1,
    kind: "ghostapi.reconciliation",
    lastRun,
    findings,
  };
}

function validateFinding(value: unknown): ReconciliationFinding {
  const finding = object(value, "Reconciliation finding is invalid.");
  exactKeys(
    finding,
    [
      "schemaVersion",
      "kind",
      "findingId",
      "tenantId",
      "actionId",
      "actionHash",
      "classification",
      "detail",
      "detectedAt",
      "status",
      "resolution",
    ],
    "Reconciliation finding",
    ["resolution"],
  );
  if (
    finding.schemaVersion !== SCHEMA_VERSION ||
    finding.kind !== "ghostapi.reconciliation-finding"
  )
    throw new ReconciliationError("Unsupported reconciliation finding schema.");
  if (
    (finding.classification !== "drifted" &&
      finding.classification !== "unknown") ||
    (finding.status !== "open" && finding.status !== "resolved")
  )
    throw new ReconciliationError(
      "Reconciliation finding classification or status is invalid.",
    );
  let resolution;
  if (finding.resolution !== undefined) {
    const value = object(
      finding.resolution,
      "Reconciliation finding resolution is invalid.",
    );
    exactKeys(
      value,
      ["resolvedAt", "resolvedBy", "reason", "evidenceRef"],
      "Reconciliation finding resolution",
      ["evidenceRef"],
    );
    resolution = {
      resolvedAt: timestamp(value.resolvedAt, "Reconciliation resolution time"),
      resolvedBy: identifier(
        value.resolvedBy,
        "Reconciliation resolution operator",
      ),
      reason: text(value.reason, "Reconciliation resolution reason", 300),
      ...(value.evidenceRef === undefined
        ? {}
        : {
            evidenceRef: evidence(
              value.evidenceRef,
              "Reconciliation evidence reference",
            ),
          }),
    };
  }
  if (finding.status === "resolved" && resolution === undefined)
    throw new ReconciliationError(
      "Resolved reconciliation findings require a resolution.",
    );
  if (finding.status === "open" && resolution !== undefined)
    throw new ReconciliationError(
      "Open reconciliation findings cannot carry a resolution.",
    );
  return {
    schemaVersion: 1,
    kind: "ghostapi.reconciliation-finding",
    findingId: identifier(finding.findingId, "Reconciliation finding id"),
    tenantId: identifier(finding.tenantId, "Reconciliation tenant id"),
    actionId: identifier(finding.actionId, "Reconciliation action id"),
    actionHash: hash(finding.actionHash, "Reconciliation action hash"),
    classification: finding.classification,
    detail: text(finding.detail, "Reconciliation finding detail", 600),
    detectedAt: timestamp(finding.detectedAt, "Reconciliation detection time"),
    status: finding.status,
    ...(resolution === undefined ? {} : { resolution }),
  };
}

function findFinding(
  state: ReconciliationState,
  findingId: string,
): ReconciliationFinding {
  const finding = state.findings.find(
    (candidate) => candidate.findingId === findingId,
  );
  if (finding === undefined)
    throw new ReconciliationError("Reconciliation finding was not found.");
  return finding;
}

function validateOperator(value: unknown): ReconciliationOperator {
  const operator = object(value, "Reconciliation operator is invalid.");
  exactKeys(
    operator,
    ["id", "principalId", "permissions"],
    "Reconciliation operator",
  );
  const permissions = array(
    operator.permissions,
    "Reconciliation operator permissions",
    8,
  ).map((permission) => {
    if (
      permission !== "reconciliation.manage" &&
      permission !== "reconciliation.inspect"
    )
      throw new ReconciliationError(
        "Reconciliation operator permission is invalid.",
      );
    return permission as ReconciliationOperatorPermission;
  });
  unique(permissions, "Reconciliation operator permissions");
  return {
    id: identifier(operator.id, "Reconciliation operator id"),
    principalId: identifier(
      operator.principalId,
      "Reconciliation operator principal id",
    ),
    permissions,
  };
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
    throw new ReconciliationError(`${label} must be a safe identifier.`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value))
    throw new ReconciliationError(`${label} must be a SHA-256 hash.`);
  return value;
}

function evidence(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 128 ||
    /[\u0000-\u001f]/.test(value) ||
    sanitizeSecretString(value) !== value
  )
    throw new ReconciliationError(
      `${label} must be a bounded non-secret reference.`,
    );
  return value.trim();
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new ReconciliationError(`${label} must be an ISO UTC timestamp.`);
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
    throw new ReconciliationError(`${label} is invalid.`);
  return value.trim();
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ReconciliationError(message);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new ReconciliationError(`${label} is invalid.`);
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
      throw new ReconciliationError(
        `${label} contains unsupported field: ${key}`,
      );
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new ReconciliationError(`${label} must be unique.`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
