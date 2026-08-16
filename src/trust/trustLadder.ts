import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";

const SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_TARGETS = 1_000;
const MAX_AUDIT = 10_000;
const MAX_EVALS = 100;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;

export const TRUST_LEVELS = ["simulate", "shadow", "dry-run", "approve", "bounded-auto", "trusted"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
export type TrustCapabilityStatus = "supported" | "unsupported";
export type TrustTarget = { provider: "ghostapi-synthetic"; environment: "synthetic"; tenantId: string; resourceId: string };
export type TrustLevelCapability = {
  level: TrustLevel;
  status: TrustCapabilityStatus;
  externalSideEffects: false;
  requiresActualContext?: boolean;
  requiresOfficialProviderSemantics?: boolean;
  requiresApproval?: boolean;
  requiresCanary?: boolean;
  requiresOutcomeComparison?: boolean;
  reason?: string;
};
export type TrustCapabilities = { schemaVersion: 1; kind: "ghostapi.trust-capabilities"; provider: "ghostapi-synthetic"; environment: "synthetic"; levels: TrustLevelCapability[] };
export type TrustCanaryScope = { tenantIds: string[]; resourceIds: string[]; percentageBps: number };
export type TrustPromotionPolicy = {
  schemaVersion: 1;
  kind: "ghostapi.trust-promotion-policy";
  id: string;
  ownerPrincipalId: string;
  automaticPromotion: false;
  minimumRuns: number;
  requiredEvalIds: string[];
  maxViolationRateBps: number;
  maxErrorRateBps: number;
  evidenceFreshnessMs: number;
  canary: TrustCanaryScope;
  stopConditions: { maxViolations: number; maxErrors: number };
  violationResponse: "demote_to_approve" | "open_circuit_breaker";
};
export type TrustPromotionEvidence = {
  runCount: number;
  violations: number;
  errors: number;
  evals: Array<{ id: string; status: "passed" | "failed"; completedAt: string }>;
  observedAt: string;
};
export type TrustOwner = { id: string; principalId: string };
export interface TrustOwnerVerifier { authenticate(identity: unknown): Promise<TrustOwner>; }
export type TrustCanaryDecision = { target: TrustTarget; assigned: boolean; bucket: number; reason: string };
export type TrustObservation = { target: TrustTarget; actionHash: string; operation: string; contextHash: string };
export type TrustOutcomeObservation = { target: TrustTarget; actionHash: string; outcomeHash: string; executionReceiptHash: string };
export type TrustComparisonEvidence = {
  schemaVersion: 1;
  kind: "ghostapi.trust-comparison";
  target: TrustTarget;
  level: "shadow" | "bounded-auto";
  matched: boolean;
  predictedHash: string;
  actualHash: string;
  observedAt: string;
};
export type TrustCanaryOutcome = "success" | "violation" | "error";
export type TrustTargetState = {
  target: TrustTarget;
  level: TrustLevel;
  circuitBreaker: "closed" | "open";
  canary: { observed: number; violations: number; errors: number };
  updatedAt: string;
};
export type TrustAuditRecord = { sequence: number; event: string; targetKey: string; fromLevel?: TrustLevel; toLevel?: TrustLevel; reason: string; timestamp: string; previousHash: string; recordHash: string };
export type TrustLadderState = { schemaVersion: 1; targets: TrustTargetState[]; auditAnchor: string; audit: TrustAuditRecord[] };
export type TrustLadderOptions = { path?: string; now?: () => Date; ownerVerifier: TrustOwnerVerifier };

export class TrustLadderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustLadderError";
  }
}

export function createLocalSyntheticTrustCapabilities(): TrustCapabilities {
  return {
    schemaVersion: 1,
    kind: "ghostapi.trust-capabilities",
    provider: "ghostapi-synthetic",
    environment: "synthetic",
    levels: [
      { level: "simulate", status: "supported", externalSideEffects: false },
      { level: "shadow", status: "supported", externalSideEffects: false, requiresActualContext: true },
      { level: "dry-run", status: "unsupported", externalSideEffects: false, requiresOfficialProviderSemantics: true, reason: "ghostapi-synthetic has no provider-official dry-run semantic." },
      { level: "approve", status: "supported", externalSideEffects: false, requiresApproval: true },
      { level: "bounded-auto", status: "supported", externalSideEffects: false, requiresCanary: true, requiresOutcomeComparison: true },
      { level: "trusted", status: "unsupported", externalSideEffects: false, reason: "The local synthetic runtime is not production authorization." }
    ]
  };
}

export function createLocalTrustLadder(options: TrustLadderOptions): LocalTrustLadder {
  return new LocalTrustLadder(options);
}

export class LocalTrustLadder {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly ownerVerifier: TrustOwnerVerifier;
  private readonly capabilities: TrustCapabilities;

  constructor(options: TrustLadderOptions) {
    this.path = options.path ?? getDataPaths().trustLadder;
    this.now = options.now ?? (() => new Date());
    this.ownerVerifier = options.ownerVerifier;
    this.capabilities = validateCapabilities(createLocalSyntheticTrustCapabilities());
  }

  getCapabilities(): TrustCapabilities {
    return clone(this.capabilities);
  }

  async inspect(targetValue: unknown): Promise<TrustTargetState> {
    const target = validateTarget(targetValue);
    return this.mutate((state, now) => clone(findOrCreateTarget(state, target, now)));
  }

  async assignCanary(targetValue: unknown, policyValue: unknown): Promise<TrustCanaryDecision> {
    const target = validateTarget(targetValue);
    const policy = validatePolicy(policyValue);
    return this.mutate((state, now) => {
      const current = findOrCreateTarget(state, target, now);
      if (current.circuitBreaker === "open") throw new TrustLadderError("Canary circuit breaker is open; no further canary action is allowed.");
      return canaryDecision(target, policy);
    });
  }

  async promote(input: { target: unknown; level: TrustLevel; policy: unknown; evidence: unknown; ownerIdentity: unknown }): Promise<TrustTargetState> {
    const target = validateTarget(input.target);
    const policy = validatePolicy(input.policy);
    const evidence = validateEvidence(input.evidence);
    const requestedLevel = trustLevel(input.level, "Trust promotion level");
    const owner = await this.ownerVerifier.authenticate(input.ownerIdentity);
    const verifiedOwner = validateOwner(owner);
    if (verifiedOwner.principalId !== policy.ownerPrincipalId) throw new TrustLadderError("Trust promotion requires the configured verified owner decision.");
    return this.mutate((state, now) => {
      const current = findOrCreateTarget(state, target, now);
      if (current.circuitBreaker === "open") throw new TrustLadderError("Trust promotion is blocked by an open circuit breaker.");
      const capability = capabilityFor(this.capabilities, requestedLevel);
      if (capability.status !== "supported") throw new TrustLadderError(`Trust level ${requestedLevel} is unsupported: ${capability.reason ?? "provider capability is unavailable"}`);
      if (requestedLevel !== nextSupportedLevel(this.capabilities, current.level)) throw new TrustLadderError("Trust promotion must move to the next supported level; automatic promotion is disabled.");
      assertPromotionEvidence(evidence, policy, now);
      if (capability.requiresCanary) {
        const decision = canaryDecision(target, policy);
        if (!decision.assigned) throw new TrustLadderError(`Canary scope denies promotion: ${decision.reason}`);
      }
      const previous = current.level;
      current.level = requestedLevel;
      current.updatedAt = now;
      appendAudit(state, "trust.promoted", current, previous, requestedLevel, `verified owner ${verifiedOwner.principalId} approved promotion`, now);
      return clone(current);
    });
  }

  async compareShadow(input: { prediction: unknown; actual: unknown }): Promise<TrustComparisonEvidence> {
    const prediction = validateObservation(input.prediction);
    const actual = validateObservation(input.actual);
    if (!sameTarget(prediction.target, actual.target)) throw new TrustLadderError("Shadow comparison cannot mix synthetic identities.");
    return this.mutate((state, now) => {
      const current = findOrCreateTarget(state, prediction.target, now);
      assertActiveLevel(current, "shadow");
      const evidence = comparisonEvidence(prediction.target, "shadow", observationHash(prediction), observationHash(actual), now);
      appendAudit(state, "shadow.compared", current, undefined, undefined, evidence.matched ? "predicted action matches actual input context" : "predicted action differs from actual input context", now);
      return evidence;
    });
  }

  async compareBoundedOutcome(input: { prediction: unknown; actual: unknown }): Promise<TrustComparisonEvidence> {
    const prediction = validateOutcomeObservation(input.prediction);
    const actual = validateOutcomeObservation(input.actual);
    if (!sameTarget(prediction.target, actual.target)) throw new TrustLadderError("Bounded outcome comparison cannot mix synthetic identities.");
    return this.mutate((state, now) => {
      const current = findOrCreateTarget(state, prediction.target, now);
      assertActiveLevel(current, "bounded-auto");
      const evidence = comparisonEvidence(prediction.target, "bounded-auto", outcomeHash(prediction), outcomeHash(actual), now);
      appendAudit(state, "bounded.outcome_compared", current, undefined, undefined, evidence.matched ? "predicted and actual bounded outcomes match" : "predicted and actual bounded outcomes differ", now);
      return evidence;
    });
  }

  async recordCanaryOutcome(input: { target: unknown; policy: unknown; outcome: TrustCanaryOutcome; reason: string }): Promise<TrustTargetState> {
    const target = validateTarget(input.target);
    const policy = validatePolicy(input.policy);
    const outcome = canaryOutcome(input.outcome);
    const reason = text(input.reason, "Canary outcome reason", 200);
    return this.mutate((state, now) => {
      const current = findOrCreateTarget(state, target, now);
      if (current.circuitBreaker === "open") throw new TrustLadderError("Canary circuit breaker is open; no further canary action is allowed.");
      if (current.level !== "bounded-auto") throw new TrustLadderError("Canary outcomes require bounded-auto trust.");
      const decision = canaryDecision(target, policy);
      if (!decision.assigned) throw new TrustLadderError(`Canary scope denies outcome recording: ${decision.reason}`);
      current.canary.observed += 1;
      if (outcome === "violation") current.canary.violations += 1;
      if (outcome === "error") current.canary.errors += 1;
      current.updatedAt = now;
      appendAudit(state, "canary.outcome", current, undefined, undefined, reason, now);
      if (outcome === "violation" && policy.violationResponse === "demote_to_approve") {
        const previous = current.level;
        current.level = "approve";
        appendAudit(state, "trust.auto_demoted", current, previous, "approve", "policy violation automatically returned trust to approval mode", now);
      }
      if ((outcome === "violation" && policy.violationResponse === "open_circuit_breaker") || (current.canary.violations > 0 && current.canary.violations >= policy.stopConditions.maxViolations) || (current.canary.errors > 0 && current.canary.errors >= policy.stopConditions.maxErrors)) {
        current.circuitBreaker = "open";
        appendAudit(state, "canary.circuit_opened", current, undefined, undefined, outcome === "violation" && policy.violationResponse === "open_circuit_breaker" ? "policy violation opened the configured circuit breaker" : "configured canary stop condition was breached", now);
      }
      return clone(current);
    });
  }

  async rollbackToApproval(input: { target: unknown; policy: unknown; ownerIdentity: unknown; reason: string }): Promise<TrustTargetState> {
    const target = validateTarget(input.target);
    const policy = validatePolicy(input.policy);
    const owner = validateOwner(await this.ownerVerifier.authenticate(input.ownerIdentity));
    const reason = text(input.reason, "Trust rollback reason", 200);
    if (owner.principalId !== policy.ownerPrincipalId) throw new TrustLadderError("Trust rollback requires the configured verified owner decision.");
    return this.mutate((state, now) => {
      const current = findOrCreateTarget(state, target, now);
      const previous = current.level;
      current.level = "approve";
      current.updatedAt = now;
      appendAudit(state, "trust.rollback_to_approval", current, previous, "approve", reason, now);
      return clone(current);
    });
  }

  async readStateForTesting(): Promise<TrustLadderState> {
    return this.read();
  }

  private async read(): Promise<TrustLadderState> {
    await ensurePrivateDirectory(dirname(this.path));
    const info = await lstat(this.path).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
    if (info === null) return emptyState();
    if (!info.isFile() || info.isSymbolicLink()) throw new TrustLadderError("Trust ladder store must be a regular non-symlink file.");
    const source = await readFile(this.path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_STORE_BYTES) throw new TrustLadderError("Trust ladder store exceeds its size limit.");
    try {
      return validateState(JSON.parse(source));
    } catch (error) {
      if (error instanceof TrustLadderError) throw error;
      throw new TrustLadderError("Trust ladder store is not valid JSON.");
    }
  }

  private async mutate<T>(operation: (state: TrustLadderState, now: string) => T): Promise<T> {
    return withFileLock(this.path, async () => {
      const state = await this.read();
      const result = operation(state, this.timestamp());
      await atomicWriteJson(this.path, validateState(state));
      return result;
    });
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TrustLadderError("Trust ladder clock is invalid.");
    return value.toISOString();
  }
}

export function createTestTrustOwnerVerifier(): { verifier: TrustOwnerVerifier; issue(input: Omit<TrustOwner, "principalId"> & { principalId?: string }): TrustOwner } {
  const issued = new WeakSet<object>();
  return {
    verifier: {
      async authenticate(identity: unknown): Promise<TrustOwner> {
        if (identity === null || typeof identity !== "object" || !issued.has(identity)) throw new TrustLadderError("Trust owner identity is not authenticated.");
        return validateOwner(identity);
      }
    },
    issue(input): TrustOwner {
      const owner = Object.freeze(validateOwner({ ...input, principalId: input.principalId ?? input.id }));
      issued.add(owner);
      return owner;
    }
  };
}

function validateCapabilities(value: unknown): TrustCapabilities {
  const capabilities = object(value, "Trust capabilities are invalid.");
  exactKeys(capabilities, ["schemaVersion", "kind", "provider", "environment", "levels"], "Trust capabilities");
  if (capabilities.schemaVersion !== SCHEMA_VERSION || capabilities.kind !== "ghostapi.trust-capabilities" || capabilities.provider !== "ghostapi-synthetic" || capabilities.environment !== "synthetic") throw new TrustLadderError("Only local synthetic trust capabilities are available.");
  const levels = array(capabilities.levels, "Trust level capabilities", TRUST_LEVELS.length).map(validateCapability);
  if (levels.length !== TRUST_LEVELS.length || levels.some((capability, index) => capability.level !== TRUST_LEVELS[index])) throw new TrustLadderError("Trust capabilities must define every level in stable order.");
  if (levels.some((capability) => capability.externalSideEffects)) throw new TrustLadderError("Local trust capabilities cannot enable external side effects.");
  return { schemaVersion: 1, kind: "ghostapi.trust-capabilities", provider: "ghostapi-synthetic", environment: "synthetic", levels };
}

function validateCapability(value: unknown): TrustLevelCapability {
  const capability = object(value, "Trust level capability is invalid.");
  exactKeys(capability, ["level", "status", "externalSideEffects", "requiresActualContext", "requiresOfficialProviderSemantics", "requiresApproval", "requiresCanary", "requiresOutcomeComparison", "reason"], "Trust level capability", ["requiresActualContext", "requiresOfficialProviderSemantics", "requiresApproval", "requiresCanary", "requiresOutcomeComparison", "reason"]);
  const level = trustLevel(capability.level, "Trust capability level");
  if (capability.status !== "supported" && capability.status !== "unsupported") throw new TrustLadderError("Trust capability status is invalid.");
  if (capability.externalSideEffects !== false) throw new TrustLadderError("Trust capability external side effects are invalid.");
  const requiresActualContext = booleanFlag(capability.requiresActualContext, "Trust capability flag");
  const requiresOfficialProviderSemantics = booleanFlag(capability.requiresOfficialProviderSemantics, "Trust capability flag");
  const requiresApproval = booleanFlag(capability.requiresApproval, "Trust capability flag");
  const requiresCanary = booleanFlag(capability.requiresCanary, "Trust capability flag");
  const requiresOutcomeComparison = booleanFlag(capability.requiresOutcomeComparison, "Trust capability flag");
  const reason = capability.reason === undefined ? undefined : text(capability.reason, "Trust capability reason", 200);
  if (capability.status === "unsupported" && reason === undefined) throw new TrustLadderError("Unsupported trust capability requires a reason.");
  return { level, status: capability.status, externalSideEffects: false, ...(requiresActualContext === undefined ? {} : { requiresActualContext }), ...(requiresOfficialProviderSemantics === undefined ? {} : { requiresOfficialProviderSemantics }), ...(requiresApproval === undefined ? {} : { requiresApproval }), ...(requiresCanary === undefined ? {} : { requiresCanary }), ...(requiresOutcomeComparison === undefined ? {} : { requiresOutcomeComparison }), ...(reason === undefined ? {} : { reason }) };
}

function validatePolicy(value: unknown): TrustPromotionPolicy {
  const policy = object(value, "Trust promotion policy is invalid.");
  exactKeys(policy, ["schemaVersion", "kind", "id", "ownerPrincipalId", "automaticPromotion", "minimumRuns", "requiredEvalIds", "maxViolationRateBps", "maxErrorRateBps", "evidenceFreshnessMs", "canary", "stopConditions", "violationResponse"], "Trust promotion policy");
  if (policy.schemaVersion !== SCHEMA_VERSION || policy.kind !== "ghostapi.trust-promotion-policy" || policy.automaticPromotion !== false) throw new TrustLadderError("Automatic trust promotion is disabled.");
  const canary = object(policy.canary, "Trust canary scope is invalid.");
  exactKeys(canary, ["tenantIds", "resourceIds", "percentageBps"], "Trust canary scope");
  const stopConditions = object(policy.stopConditions, "Trust canary stop conditions are invalid.");
  exactKeys(stopConditions, ["maxViolations", "maxErrors"], "Trust canary stop conditions");
  if (policy.violationResponse !== "demote_to_approve" && policy.violationResponse !== "open_circuit_breaker") throw new TrustLadderError("Trust violation response is invalid.");
  return {
    schemaVersion: 1,
    kind: "ghostapi.trust-promotion-policy",
    id: identifier(policy.id, "Trust policy id"),
    ownerPrincipalId: identifier(policy.ownerPrincipalId, "Trust owner principal id"),
    automaticPromotion: false,
    minimumRuns: positive(policy.minimumRuns, "Trust minimum runs", 1_000_000),
    requiredEvalIds: identifiers(policy.requiredEvalIds, "Trust required eval ids", MAX_EVALS),
    maxViolationRateBps: bps(policy.maxViolationRateBps, "Trust maximum violation rate"),
    maxErrorRateBps: bps(policy.maxErrorRateBps, "Trust maximum error rate"),
    evidenceFreshnessMs: positive(policy.evidenceFreshnessMs, "Trust evidence freshness", MAX_FRESHNESS_MS),
    canary: { tenantIds: identifiers(canary.tenantIds, "Trust canary tenant ids", MAX_TARGETS, true), resourceIds: identifiers(canary.resourceIds, "Trust canary resource ids", MAX_TARGETS, true), percentageBps: bps(canary.percentageBps, "Trust canary percentage") },
    stopConditions: { maxViolations: nonNegative(stopConditions.maxViolations, "Trust canary maximum violations", 1_000_000), maxErrors: nonNegative(stopConditions.maxErrors, "Trust canary maximum errors", 1_000_000) },
    violationResponse: policy.violationResponse
  };
}

function validateEvidence(value: unknown): TrustPromotionEvidence {
  const evidence = object(value, "Trust promotion evidence is invalid.");
  exactKeys(evidence, ["runCount", "violations", "errors", "evals", "observedAt"], "Trust promotion evidence");
  const runCount = nonNegative(evidence.runCount, "Trust evidence run count", 1_000_000);
  const violations = nonNegative(evidence.violations, "Trust evidence violation count", runCount);
  const errors = nonNegative(evidence.errors, "Trust evidence error count", runCount);
  const evals: TrustPromotionEvidence["evals"] = array(evidence.evals, "Trust evidence evals", MAX_EVALS).map((entry) => {
    const evaluation = object(entry, "Trust evidence eval is invalid.");
    exactKeys(evaluation, ["id", "status", "completedAt"], "Trust evidence eval");
    if (evaluation.status !== "passed" && evaluation.status !== "failed") throw new TrustLadderError("Trust evidence eval status is invalid.");
    return { id: identifier(evaluation.id, "Trust evidence eval id"), status: evaluation.status, completedAt: timestamp(evaluation.completedAt, "Trust evidence eval completion") };
  });
  unique(evals.map((evaluation) => evaluation.id), "Trust evidence eval ids");
  return { runCount, violations, errors, evals, observedAt: timestamp(evidence.observedAt, "Trust evidence observation time") };
}

function validateTarget(value: unknown): TrustTarget {
  const target = object(value, "Trust target is invalid.");
  exactKeys(target, ["provider", "environment", "tenantId", "resourceId"], "Trust target");
  if (target.provider !== "ghostapi-synthetic" || target.environment !== "synthetic") throw new TrustLadderError("Local trust preparation accepts synthetic identities only; production identities are unsupported.");
  return { provider: "ghostapi-synthetic", environment: "synthetic", tenantId: identifier(target.tenantId, "Trust target tenant id"), resourceId: identifier(target.resourceId, "Trust target resource id") };
}

function validateObservation(value: unknown): TrustObservation {
  const observation = object(value, "Shadow observation is invalid.");
  exactKeys(observation, ["target", "actionHash", "operation", "contextHash"], "Shadow observation");
  return { target: validateTarget(observation.target), actionHash: hash(observation.actionHash, "Shadow action hash"), operation: identifier(observation.operation, "Shadow operation"), contextHash: hash(observation.contextHash, "Shadow context hash") };
}

function validateOutcomeObservation(value: unknown): TrustOutcomeObservation {
  const observation = object(value, "Bounded outcome observation is invalid.");
  exactKeys(observation, ["target", "actionHash", "outcomeHash", "executionReceiptHash"], "Bounded outcome observation");
  return { target: validateTarget(observation.target), actionHash: hash(observation.actionHash, "Bounded action hash"), outcomeHash: hash(observation.outcomeHash, "Bounded outcome hash"), executionReceiptHash: hash(observation.executionReceiptHash, "Bounded execution receipt hash") };
}

function validateOwner(value: unknown): TrustOwner {
  const owner = object(value, "Trust owner identity is invalid.");
  exactKeys(owner, ["id", "principalId"], "Trust owner identity");
  return { id: identifier(owner.id, "Trust owner id"), principalId: identifier(owner.principalId, "Trust owner principal id") };
}

function validateState(value: unknown): TrustLadderState {
  const state = object(value, "Trust ladder store must be an object.");
  exactKeys(state, ["schemaVersion", "targets", "auditAnchor", "audit"], "Trust ladder store");
  if (state.schemaVersion !== SCHEMA_VERSION) throw new TrustLadderError("Unsupported trust ladder schema version.");
  const targets = array(state.targets, "Trust targets", MAX_TARGETS).map(validateTargetState);
  unique(targets.map((target) => targetKey(target.target)), "Trust targets");
  const auditAnchor = hash(state.auditAnchor, "Trust audit anchor");
  const audit = array(state.audit, "Trust audit", MAX_AUDIT).map(validateAudit);
  validateAuditChain(auditAnchor, audit);
  return { schemaVersion: 1, targets, auditAnchor, audit };
}

function validateTargetState(value: unknown): TrustTargetState {
  const state = object(value, "Trust target state is invalid.");
  exactKeys(state, ["target", "level", "circuitBreaker", "canary", "updatedAt"], "Trust target state");
  const canary = object(state.canary, "Trust target canary state is invalid.");
  exactKeys(canary, ["observed", "violations", "errors"], "Trust target canary state");
  const observed = nonNegative(canary.observed, "Trust canary observed count", 1_000_000);
  const violations = nonNegative(canary.violations, "Trust canary violation count", observed);
  const errors = nonNegative(canary.errors, "Trust canary error count", observed);
  if (state.circuitBreaker !== "closed" && state.circuitBreaker !== "open") throw new TrustLadderError("Trust circuit breaker state is invalid.");
  return { target: validateTarget(state.target), level: trustLevel(state.level, "Trust target level"), circuitBreaker: state.circuitBreaker, canary: { observed, violations, errors }, updatedAt: timestamp(state.updatedAt, "Trust target update time") };
}

function validateAudit(value: unknown): TrustAuditRecord {
  const record = object(value, "Trust audit record is invalid.");
  exactKeys(record, ["sequence", "event", "targetKey", "fromLevel", "toLevel", "reason", "timestamp", "previousHash", "recordHash"], "Trust audit record", ["fromLevel", "toLevel"]);
  const base = {
    sequence: positive(record.sequence, "Trust audit sequence", MAX_AUDIT),
    event: text(record.event, "Trust audit event", 80),
    targetKey: identifier(record.targetKey, "Trust audit target key"),
    ...(record.fromLevel === undefined ? {} : { fromLevel: trustLevel(record.fromLevel, "Trust audit from level") }),
    ...(record.toLevel === undefined ? {} : { toLevel: trustLevel(record.toLevel, "Trust audit to level") }),
    reason: text(record.reason, "Trust audit reason", 200),
    timestamp: timestamp(record.timestamp, "Trust audit timestamp"),
    previousHash: hash(record.previousHash, "Trust audit previous hash")
  };
  if (hash(record.recordHash, "Trust audit record hash") !== sha256(canonical(base))) throw new TrustLadderError("Trust audit record hash is invalid.");
  return { ...base, recordHash: record.recordHash as string };
}

function validateAuditChain(anchor: string, records: TrustAuditRecord[]): void {
  let previous = anchor;
  let sequence = 1;
  for (const record of records) {
    if (record.sequence !== sequence || record.previousHash !== previous) throw new TrustLadderError("Trust audit chain is invalid.");
    previous = record.recordHash;
    sequence += 1;
  }
}

function emptyState(): TrustLadderState {
  return { schemaVersion: 1, targets: [], auditAnchor: sha256("ghostapi.trust.audit.v1"), audit: [] };
}

function findOrCreateTarget(state: TrustLadderState, target: TrustTarget, now: string): TrustTargetState {
  const existing = state.targets.find((candidate) => sameTarget(candidate.target, target));
  if (existing !== undefined) return existing;
  if (state.targets.length >= MAX_TARGETS) throw new TrustLadderError("Trust target limit was reached.");
  const created: TrustTargetState = { target: clone(target), level: "simulate", circuitBreaker: "closed", canary: { observed: 0, violations: 0, errors: 0 }, updatedAt: now };
  state.targets.push(created);
  return created;
}

function assertPromotionEvidence(evidence: TrustPromotionEvidence, policy: TrustPromotionPolicy, now: string): void {
  if (evidence.runCount < policy.minimumRuns) throw new TrustLadderError("Trust promotion evidence has too few runs.");
  if (Date.parse(evidence.observedAt) > Date.parse(now)) throw new TrustLadderError("Trust promotion evidence is from the future.");
  if (Date.parse(now) - Date.parse(evidence.observedAt) > policy.evidenceFreshnessMs) throw new TrustLadderError("Trust promotion evidence is stale.");
  for (const required of policy.requiredEvalIds) {
    const evaluation = evidence.evals.find((candidate) => candidate.id === required);
    if (evaluation === undefined || evaluation.status !== "passed") throw new TrustLadderError(`Trust promotion requires passing eval: ${required}`);
    if (Date.parse(evaluation.completedAt) > Date.parse(now)) throw new TrustLadderError(`Trust promotion eval is from the future: ${required}`);
    if (Date.parse(now) - Date.parse(evaluation.completedAt) > policy.evidenceFreshnessMs) throw new TrustLadderError(`Trust promotion eval is stale: ${required}`);
  }
  if (rateBps(evidence.violations, evidence.runCount) > policy.maxViolationRateBps) throw new TrustLadderError("Trust promotion violation rate exceeds policy.");
  if (rateBps(evidence.errors, evidence.runCount) > policy.maxErrorRateBps) throw new TrustLadderError("Trust promotion error rate exceeds policy.");
}

function nextSupportedLevel(capabilities: TrustCapabilities, current: TrustLevel): TrustLevel | undefined {
  const index = TRUST_LEVELS.indexOf(current);
  for (const level of TRUST_LEVELS.slice(index + 1)) if (capabilityFor(capabilities, level).status === "supported") return level;
  return undefined;
}

function capabilityFor(capabilities: TrustCapabilities, level: TrustLevel): TrustLevelCapability {
  const capability = capabilities.levels.find((candidate) => candidate.level === level);
  if (capability === undefined) throw new TrustLadderError("Trust capability is missing.");
  return capability;
}

function canaryDecision(target: TrustTarget, policy: TrustPromotionPolicy): TrustCanaryDecision {
  if (policy.canary.tenantIds.length > 0 && !policy.canary.tenantIds.includes(target.tenantId)) return { target: clone(target), assigned: false, bucket: deterministicBucket(policy.id, target), reason: "tenant is outside the configured canary scope" };
  if (policy.canary.resourceIds.length > 0 && !policy.canary.resourceIds.includes(target.resourceId)) return { target: clone(target), assigned: false, bucket: deterministicBucket(policy.id, target), reason: "resource is outside the configured canary scope" };
  const bucket = deterministicBucket(policy.id, target);
  return bucket < policy.canary.percentageBps
    ? { target: clone(target), assigned: true, bucket, reason: "target is inside deterministic canary scope" }
    : { target: clone(target), assigned: false, bucket, reason: "target is outside the configured canary percentage" };
}

function deterministicBucket(policyId: string, target: TrustTarget): number {
  return createHash("sha256").update(`ghostapi.trust.canary.v1:${policyId}:${targetKey(target)}`, "utf8").digest().readUInt32BE(0) % 10_000;
}

function comparisonEvidence(target: TrustTarget, level: "shadow" | "bounded-auto", predictedHash: string, actualHash: string, observedAt: string): TrustComparisonEvidence {
  return { schemaVersion: 1, kind: "ghostapi.trust-comparison", target: clone(target), level, matched: predictedHash === actualHash, predictedHash, actualHash, observedAt };
}

function observationHash(value: TrustObservation): string {
  return sha256(canonical(value));
}

function outcomeHash(value: TrustOutcomeObservation): string {
  return sha256(canonical(value));
}

function appendAudit(state: TrustLadderState, event: string, target: TrustTargetState, fromLevel: TrustLevel | undefined, toLevel: TrustLevel | undefined, reason: string, timestampValue: string): void {
  if (state.audit.length >= MAX_AUDIT) throw new TrustLadderError("Trust audit limit was reached.");
  const previousHash = state.audit.at(-1)?.recordHash ?? state.auditAnchor;
  const base = { sequence: state.audit.length + 1, event: text(event, "Trust audit event", 80), targetKey: targetKey(target.target), ...(fromLevel === undefined ? {} : { fromLevel }), ...(toLevel === undefined ? {} : { toLevel }), reason: text(reason, "Trust audit reason", 200), timestamp: timestampValue, previousHash };
  state.audit.push({ ...base, recordHash: sha256(canonical(base)) });
}

function assertActiveLevel(state: TrustTargetState, level: "shadow" | "bounded-auto"): void {
  if (state.circuitBreaker === "open") throw new TrustLadderError("Canary circuit breaker is open; comparisons cannot continue.");
  if (state.level !== level) throw new TrustLadderError(`Trust target is not active at ${level}.`);
}

function sameTarget(left: TrustTarget, right: TrustTarget): boolean {
  return left.provider === right.provider && left.environment === right.environment && left.tenantId === right.tenantId && left.resourceId === right.resourceId;
}

function targetKey(target: TrustTarget): string {
  return `target-${sha256(canonical(target)).slice(0, 32)}`;
}

function trustLevel(value: unknown, label: string): TrustLevel {
  if (typeof value !== "string" || !TRUST_LEVELS.includes(value as TrustLevel)) throw new TrustLadderError(`${label} is invalid.`);
  return value as TrustLevel;
}

function canaryOutcome(value: unknown): TrustCanaryOutcome {
  if (value !== "success" && value !== "violation" && value !== "error") throw new TrustLadderError("Trust canary outcome is invalid.");
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || sanitizeSecretString(value) !== value) throw new TrustLadderError(`${label} must be a safe identifier.`);
  return value;
}

function identifiers(value: unknown, label: string, max: number, allowEmpty = false): string[] {
  const values = array(value, label, max).map((entry) => identifier(entry, label));
  if (!allowEmpty && values.length === 0) throw new TrustLadderError(`${label} must not be empty.`);
  unique(values, label);
  return values.sort();
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new TrustLadderError(`${label} must be a SHA-256 hash.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new TrustLadderError(`${label} must be an ISO UTC timestamp.`);
  return value;
}

function positive(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new TrustLadderError(`${label} is invalid.`);
  return value;
}

function nonNegative(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new TrustLadderError(`${label} is invalid.`);
  return value;
}

function bps(value: unknown, label: string): number {
  return nonNegative(value, label, 10_000);
}

function booleanFlag(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TrustLadderError(`${label} is invalid.`);
  return value;
}

function rateBps(count: number, total: number): number {
  return total === 0 ? 10_000 : Math.floor((count * 10_000) / total);
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength || /[\u0000-\u001f]/.test(value) || sanitizeSecretString(value) !== value) throw new TrustLadderError(`${label} is invalid.`);
  return value.trim();
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TrustLadderError(message);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new TrustLadderError(`${label} is invalid.`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string, optional: string[] = []): void {
  for (const key of Object.keys(value)) if (!keys.includes(key) || (value[key] === undefined && !optional.includes(key))) throw new TrustLadderError(`${label} contains unsupported field: ${key}`);
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TrustLadderError(`${label} must be unique.`);
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new TrustLadderError("Trust data must be JSON.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
