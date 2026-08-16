import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";

const SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_CONTROLS = 1_000;
const MAX_LEDGER = 10_000;
const MAX_QUEUE = 100;
const MAX_DEAD_LETTERS = 1_000;
const MAX_AUDIT = 10_000;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

export const SAFETY_SCOPE_KINDS = ["global", "organization", "project", "environment", "agent", "workload", "provider", "operation", "risk_class"] as const;
export type SafetyScopeKind = (typeof SAFETY_SCOPE_KINDS)[number];
export type SafetyScope = { kind: SafetyScopeKind; id?: string };
export type SafetyAction = {
  organizationId: string;
  projectId: string;
  environment: string;
  actorId: string;
  workloadId: string;
  provider: string;
  operation: string;
  riskClass: "read" | "write" | "money_movement" | "external_communication" | "delete" | "deploy";
  idempotencyKey: string;
  actionHash: string;
  costs: { monetaryAmountMinor: number; requests: number; messages: number; mutations: number; deletes: number; tokenCost: number };
};
export type SafetyBudgetLimits = Partial<{ monetaryAmountMinor: number; requests: number; messages: number; mutations: number; deletes: number; tokenCost: number; concurrency: number; velocity: number }>;
export type SafetyBudget = { id: string; scope: SafetyScope; windowMs: number; velocityWindowMs: number; limits: SafetyBudgetLimits };
export type SafetyCircuit = { id: string; scope: SafetyScope; windowMs: number; minimumSamples: number; maxFailureRateBps: number; maxPolicyViolations: number; maxLatencyMs: number; maxReconciliationMismatches: number; state: "closed" | "open"; openedAt?: string; reason?: string };
export type SafetyOperatorPermission = "safety.stop" | "safety.reenable" | "safety.configure" | "safety.inspect";
export type SafetyOperator = { id: string; principalId: string; permissions: SafetyOperatorPermission[] };
export interface SafetyEmergencyAuthorizer { authenticate(identity: unknown): Promise<SafetyOperator>; }
export type SafetyLease = { replay: boolean; assertActive(): Promise<void>; commit<T>(operation: () => Promise<T>): Promise<T>; complete(outcome: { success: boolean; policyViolation?: boolean; reconciliationMismatch?: boolean; latencyMs: number; reason?: string }): Promise<void> };
export type SafetyQueueItem = { id: string; action: SafetyAction; queuedAt: string };
export type SafetyDeadLetter = SafetyQueueItem & { reason: string; deadLetteredAt: string };
export type SafetyAuditRecord = { sequence: number; event: string; subject: string; reason: string; actorPrincipalId?: string; timestamp: string; previousHash: string; recordHash: string };
export type SafetyControllerState = {
  schemaVersion: 1;
  switches: Array<{ scope: SafetyScope; enabled: boolean; changedAt: string; reason: string; changedBy: string }>;
  budgets: SafetyBudget[];
  circuits: SafetyCircuit[];
  ledger: Array<{ key: string; action: SafetyAction; status: "reserved" | "completed"; admittedAt: string; completedAt?: string; outcome?: { success: boolean; policyViolation: boolean; reconciliationMismatch: boolean; latencyMs: number; reason?: string } }>;
  queue: SafetyQueueItem[];
  deadLetters: SafetyDeadLetter[];
  auditAnchor: string;
  audit: SafetyAuditRecord[];
};
export type SafetyControllerOptions = { path?: string; now?: () => Date; emergencyAuthorizer?: SafetyEmergencyAuthorizer };

export class SafetyControllerError extends Error {
  constructor(message: string) { super(message); this.name = "SafetyControllerError"; }
}

export function createLocalSafetyController(options: SafetyControllerOptions = {}): LocalSafetyController {
  return new LocalSafetyController(options);
}

export class LocalSafetyController {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly emergencyAuthorizer: SafetyEmergencyAuthorizer;

  constructor(options: SafetyControllerOptions = {}) {
    this.path = options.path ?? getDataPaths().safetyController;
    this.now = options.now ?? (() => new Date());
    this.emergencyAuthorizer = options.emergencyAuthorizer ?? createDisabledSafetyEmergencyAuthorizer();
  }

  async configureBudget(input: { identity: unknown; budget: unknown }): Promise<SafetyBudget> {
    const operator = await this.authorize(input.identity, "safety.configure");
    const budget = validateBudget(input.budget);
    return this.mutate((state, now) => {
      const existing = state.budgets.find((candidate) => candidate.id === budget.id);
      if (existing === undefined) {
        if (state.budgets.length >= MAX_CONTROLS) throw new SafetyControllerError("Safety budget limit was reached.");
        state.budgets.push(budget);
      } else Object.assign(existing, budget);
      appendAudit(state, "budget.configured", budget.id, `configured ${scopeKey(budget.scope)}`, now, operator.principalId);
      return clone(budget);
    });
  }

  async configureCircuit(input: { identity: unknown; circuit: unknown }): Promise<SafetyCircuit> {
    const operator = await this.authorize(input.identity, "safety.configure");
    const circuit = validateCircuit(input.circuit);
    return this.mutate((state, now) => {
      const existing = state.circuits.find((candidate) => candidate.id === circuit.id);
      if (existing === undefined) {
        if (state.circuits.length >= MAX_CONTROLS) throw new SafetyControllerError("Safety circuit limit was reached.");
        state.circuits.push(circuit);
      } else Object.assign(existing, circuit);
      appendAudit(state, "circuit.configured", circuit.id, `configured ${scopeKey(circuit.scope)}`, now, operator.principalId);
      return clone(circuit);
    });
  }

  async stop(input: { identity: unknown; scope: unknown; reason: string }): Promise<void> {
    const operator = await this.authorize(input.identity, "safety.stop");
    const scope = validateScope(input.scope);
    const reason = text(input.reason, "Kill-switch reason", 200);
    await this.mutate((state, now) => {
      setSwitch(state, scope, true, reason, operator.principalId, now);
      deadLetterMatchingQueued(state, scope, reason, now);
      appendAudit(state, "kill_switch.stopped", scopeKey(scope), reason, now, operator.principalId);
    });
  }

  async reenable(input: { identity: unknown; scope: unknown; reason: string }): Promise<void> {
    const operator = await this.authorize(input.identity, "safety.reenable");
    const scope = validateScope(input.scope);
    const reason = text(input.reason, "Kill-switch re-enable reason", 200);
    await this.mutate((state, now) => {
      const control = state.switches.find((candidate) => sameScope(candidate.scope, scope));
      if (control === undefined || !control.enabled) throw new SafetyControllerError("Kill switch is not active for this scope.");
      control.enabled = false;
      control.changedAt = now;
      control.changedBy = operator.principalId;
      control.reason = reason;
      appendAudit(state, "kill_switch.reenabled", scopeKey(scope), reason, now, operator.principalId);
    });
  }

  async admit(actionValue: unknown): Promise<SafetyLease> {
    const action = validateAction(actionValue);
    const now = this.timestamp();
    const key = ledgerKey(action);
    const replay = await this.mutate((state, current) => {
      const sameIdempotency = state.ledger.find((candidate) => candidate.action.idempotencyKey === action.idempotencyKey);
      if (sameIdempotency !== undefined && sameIdempotency.action.actionHash !== action.actionHash) throw new SafetyControllerError("Safety idempotency key collides with a different action hash.");
      const existing = state.ledger.find((candidate) => candidate.key === key);
      if (existing !== undefined) return true;
      assertActionAllowed(state, action, current);
      if (state.ledger.length >= MAX_LEDGER) throw new SafetyControllerError("Safety ledger limit was reached.");
      assertBudgets(state, action, current);
      state.ledger.push({ key, action, status: "reserved", admittedAt: current });
      appendAudit(state, "action.admitted", key, "budget reservation created", current);
      return false;
    });
    return {
      replay,
      assertActive: async () => {
        if (replay) return;
        await this.mutate((state, current) => {
          const entry = findLedger(state, key);
          if (entry.status !== "reserved") throw new SafetyControllerError("Safety lease is no longer active.");
          assertActionAllowed(state, action, current);
          appendAudit(state, "action.final_check", key, "kill switch, budgets, and circuits remain active", current);
        });
      },
      commit: async <T>(operation: () => Promise<T>): Promise<T> => {
        if (replay) throw new SafetyControllerError("Safety replay lease cannot commit a side effect.");
        return withFileLock(this.path, async () => {
          const state = await this.read();
          const entry = findLedger(state, key);
          if (entry.status !== "reserved") throw new SafetyControllerError("Safety lease is no longer active.");
          assertActionAllowed(state, action, this.timestamp());
          appendAudit(state, "action.final_check", key, "kill switch, budgets, and circuits remained active through synthetic commit", this.timestamp());
          await atomicWriteJson(this.path, validateState(state));
          return operation();
        });
      },
      complete: async (outcomeValue) => {
        if (replay) return;
        const outcome = validateOutcome(outcomeValue);
        await this.mutate((state, current) => {
          const entry = findLedger(state, key);
          if (entry.status === "completed") return;
          if (entry.status !== "reserved") throw new SafetyControllerError("Safety lease is no longer active.");
          entry.status = "completed";
          entry.completedAt = current;
          entry.outcome = outcome;
          appendAudit(state, outcome.success ? "action.completed" : "action.unknown", key, outcome.reason ?? (outcome.success ? "action completed" : "action outcome is unknown"), current);
          evaluateCircuits(state, action, current);
        });
      }
    };
  }

  async enqueue(actionValue: unknown): Promise<SafetyQueueItem> {
    const action = validateAction(actionValue);
    return this.mutate((state, now) => {
      assertActionAllowed(state, action, now);
      const existing = state.queue.find((item) => ledgerKey(item.action) === ledgerKey(action));
      if (existing !== undefined) return clone(existing);
      if (state.queue.length >= MAX_QUEUE) throw new SafetyControllerError("Safety queue is full; backpressure is active.");
      const item = { id: `queue-${sha256(`${ledgerKey(action)}:${now}`).slice(0, 32)}`, action, queuedAt: now };
      state.queue.push(item);
      appendAudit(state, "queue.enqueued", item.id, "action is queued without execution", now);
      return clone(item);
    });
  }

  async dequeue(): Promise<SafetyQueueItem | null> {
    return this.mutate((state, now) => {
      const item = state.queue.shift();
      if (item === undefined) return null;
      try {
        assertActionAllowed(state, item.action, now);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Safety queue action is denied.";
        addDeadLetter(state, item, reason, now);
        appendAudit(state, "queue.dead_lettered", item.id, reason, now);
        return null;
      }
      appendAudit(state, "queue.dequeued", item.id, "dequeued for separate re-admission", now);
      return clone(item);
    });
  }

  async runScheduledGameDay(input: { stopIdentity: unknown; reenableIdentity: unknown; action: unknown; reason: string }): Promise<{ passed: true; stoppedAt: string; reenabledAt: string }> {
    const action = validateAction(input.action);
    const reason = text(input.reason, "Game-day reason", 200);
    const globalScope: SafetyScope = { kind: "global" };
    const before = await this.read();
    if (before.switches.some((control) => sameScope(control.scope, globalScope) && control.enabled)) throw new SafetyControllerError("Game-day test requires an inactive global kill switch.");
    await this.stop({ identity: input.stopIdentity, scope: globalScope, reason: `${reason} stop drill` });
    const stoppedAt = this.timestamp();
    await this.admit(action).then(() => { throw new SafetyControllerError("Game-day kill switch did not block the action."); }, (error: unknown) => {
      if (!(error instanceof SafetyControllerError) || !error.message.includes("Kill switch")) throw error;
    });
    await this.reenable({ identity: input.reenableIdentity, scope: globalScope, reason: `${reason} recovery drill` });
    const reenabledAt = this.timestamp();
    await this.mutate((state, now) => appendAudit(state, "game_day.passed", ledgerKey(action), reason, now));
    return { passed: true, stoppedAt, reenabledAt };
  }

  async inspect(): Promise<SafetyControllerState> { return this.read(); }
  async readStateForTesting(): Promise<SafetyControllerState> { return this.read(); }

  private async authorize(identity: unknown, permission: SafetyOperatorPermission): Promise<SafetyOperator> {
    const operator = validateOperator(await this.emergencyAuthorizer.authenticate(identity));
    if (!operator.permissions.includes(permission)) throw new SafetyControllerError(`Emergency operator lacks required permission: ${permission}.`);
    return operator;
  }

  private async read(): Promise<SafetyControllerState> {
    await ensurePrivateDirectory(dirname(this.path));
    const info = await lstat(this.path).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
    if (info === null) return emptyState();
    if (!info.isFile() || info.isSymbolicLink()) throw new SafetyControllerError("Safety controller store must be a regular non-symlink file.");
    const source = await readFile(this.path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_STORE_BYTES) throw new SafetyControllerError("Safety controller store exceeds its size limit.");
    try { return validateState(JSON.parse(source)); } catch (error) { if (error instanceof SafetyControllerError) throw error; throw new SafetyControllerError("Safety controller store is not valid JSON."); }
  }

  private async mutate<T>(operation: (state: SafetyControllerState, now: string) => T): Promise<T> {
    return withFileLock(this.path, async () => {
      const state = await this.read();
      const result = operation(state, this.timestamp());
      await atomicWriteJson(this.path, validateState(state));
      return result;
    });
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new SafetyControllerError("Safety controller clock is invalid.");
    return value.toISOString();
  }
}

export function createDisabledSafetyEmergencyAuthorizer(): SafetyEmergencyAuthorizer {
  return { async authenticate(): Promise<never> { throw new SafetyControllerError("Emergency authorization is not configured."); } };
}

export function createTestSafetyEmergencyAuthorizer(): { authorizer: SafetyEmergencyAuthorizer; issue(input: SafetyOperator): SafetyOperator } {
  const issued = new WeakSet<object>();
  return {
    authorizer: { async authenticate(identity: unknown): Promise<SafetyOperator> { if (identity === null || typeof identity !== "object" || !issued.has(identity)) throw new SafetyControllerError("Emergency operator identity is not authenticated."); return validateOperator(identity); } },
    issue(input): SafetyOperator { const operator = Object.freeze(validateOperator(input)); issued.add(operator); return operator; }
  };
}

function emptyState(): SafetyControllerState { return { schemaVersion: 1, switches: [], budgets: [], circuits: [], ledger: [], queue: [], deadLetters: [], auditAnchor: sha256("ghostapi.safety.audit.v1"), audit: [] }; }
function validateState(value: unknown): SafetyControllerState {
  const state = object(value, "Safety controller store must be an object.");
  exactKeys(state, ["schemaVersion", "switches", "budgets", "circuits", "ledger", "queue", "deadLetters", "auditAnchor", "audit"], "Safety controller store");
  if (state.schemaVersion !== SCHEMA_VERSION) throw new SafetyControllerError("Unsupported safety controller schema version.");
  const switches = array(state.switches, "Safety switches", MAX_CONTROLS).map(validateSwitch);
  unique(switches.map((control) => scopeKey(control.scope)), "Safety switch scopes");
  const budgets = array(state.budgets, "Safety budgets", MAX_CONTROLS).map(validateBudget);
  unique(budgets.map((budget) => budget.id), "Safety budget ids");
  const circuits = array(state.circuits, "Safety circuits", MAX_CONTROLS).map(validateCircuit);
  unique(circuits.map((circuit) => circuit.id), "Safety circuit ids");
  const ledger = array(state.ledger, "Safety ledger", MAX_LEDGER).map(validateLedger);
  unique(ledger.map((entry) => entry.key), "Safety ledger keys");
  unique(ledger.map((entry) => entry.action.idempotencyKey), "Safety ledger idempotency keys");
  const queue = array(state.queue, "Safety queue", MAX_QUEUE).map(validateQueueItem);
  unique(queue.map((entry) => entry.id), "Safety queue ids");
  const deadLetters = array(state.deadLetters, "Safety dead-letter queue", MAX_DEAD_LETTERS).map(validateDeadLetter);
  unique(deadLetters.map((entry) => entry.id), "Safety dead-letter ids");
  const auditAnchor = hash(state.auditAnchor, "Safety audit anchor");
  const audit = array(state.audit, "Safety audit", MAX_AUDIT).map(validateAudit);
  validateAuditChain(auditAnchor, audit);
  return { schemaVersion: 1, switches, budgets, circuits, ledger, queue, deadLetters, auditAnchor, audit };
}
function validateSwitch(value: unknown): SafetyControllerState["switches"][number] { const control = object(value, "Safety switch is invalid."); exactKeys(control, ["scope", "enabled", "changedAt", "reason", "changedBy"], "Safety switch"); if (typeof control.enabled !== "boolean") throw new SafetyControllerError("Safety switch enabled flag is invalid."); return { scope: validateScope(control.scope), enabled: control.enabled, changedAt: timestamp(control.changedAt, "Safety switch time"), reason: text(control.reason, "Safety switch reason", 200), changedBy: identifier(control.changedBy, "Safety switch operator") }; }
function validateBudget(value: unknown): SafetyBudget {
  const budget = object(value, "Safety budget is invalid."); exactKeys(budget, ["id", "scope", "windowMs", "velocityWindowMs", "limits"], "Safety budget");
  const limits = object(budget.limits, "Safety budget limits are invalid."); exactKeys(limits, ["monetaryAmountMinor", "requests", "messages", "mutations", "deletes", "tokenCost", "concurrency", "velocity"], "Safety budget limits", ["monetaryAmountMinor", "requests", "messages", "mutations", "deletes", "tokenCost", "concurrency", "velocity"]);
  const parsed: SafetyBudgetLimits = {};
  for (const key of ["monetaryAmountMinor", "requests", "messages", "mutations", "deletes", "tokenCost", "concurrency", "velocity"] as const) if (limits[key] !== undefined) parsed[key] = nonNegative(limits[key], `Safety budget ${key}`, Number.MAX_SAFE_INTEGER);
  if (Object.keys(parsed).length === 0) throw new SafetyControllerError("Safety budget requires at least one limit.");
  return { id: identifier(budget.id, "Safety budget id"), scope: validateScope(budget.scope), windowMs: boundedMs(budget.windowMs, "Safety budget window"), velocityWindowMs: boundedMs(budget.velocityWindowMs, "Safety velocity window"), limits: parsed };
}
function validateCircuit(value: unknown): SafetyCircuit {
  const circuit = object(value, "Safety circuit is invalid."); exactKeys(circuit, ["id", "scope", "windowMs", "minimumSamples", "maxFailureRateBps", "maxPolicyViolations", "maxLatencyMs", "maxReconciliationMismatches", "state", "openedAt", "reason"], "Safety circuit", ["openedAt", "reason"]);
  if (circuit.state !== "closed" && circuit.state !== "open") throw new SafetyControllerError("Safety circuit state is invalid.");
  const result: SafetyCircuit = { id: identifier(circuit.id, "Safety circuit id"), scope: validateScope(circuit.scope), windowMs: boundedMs(circuit.windowMs, "Safety circuit window"), minimumSamples: positive(circuit.minimumSamples, "Safety circuit minimum samples", MAX_LEDGER), maxFailureRateBps: bps(circuit.maxFailureRateBps, "Safety circuit failure rate"), maxPolicyViolations: nonNegative(circuit.maxPolicyViolations, "Safety circuit policy violations", MAX_LEDGER), maxLatencyMs: nonNegative(circuit.maxLatencyMs, "Safety circuit latency", 24 * 60 * 60 * 1000), maxReconciliationMismatches: nonNegative(circuit.maxReconciliationMismatches, "Safety circuit reconciliation mismatches", MAX_LEDGER), state: circuit.state };
  if (result.state === "open") { if (circuit.openedAt === undefined || circuit.reason === undefined) throw new SafetyControllerError("Open safety circuit requires audit metadata."); result.openedAt = timestamp(circuit.openedAt, "Safety circuit open time"); result.reason = text(circuit.reason, "Safety circuit reason", 200); }
  return result;
}
function validateAction(value: unknown): SafetyAction {
  const action = object(value, "Safety action is invalid."); exactKeys(action, ["organizationId", "projectId", "environment", "actorId", "workloadId", "provider", "operation", "riskClass", "idempotencyKey", "actionHash", "costs"], "Safety action");
  if (action.riskClass !== "read" && action.riskClass !== "write" && action.riskClass !== "money_movement" && action.riskClass !== "external_communication" && action.riskClass !== "delete" && action.riskClass !== "deploy") throw new SafetyControllerError("Safety action risk class is invalid.");
  const costs = object(action.costs, "Safety action costs are invalid."); exactKeys(costs, ["monetaryAmountMinor", "requests", "messages", "mutations", "deletes", "tokenCost"], "Safety action costs");
  return { organizationId: identifier(action.organizationId, "Safety organization id"), projectId: identifier(action.projectId, "Safety project id"), environment: identifier(action.environment, "Safety environment"), actorId: identifier(action.actorId, "Safety actor id"), workloadId: identifier(action.workloadId, "Safety workload id"), provider: identifier(action.provider, "Safety provider"), operation: identifier(action.operation, "Safety operation"), riskClass: action.riskClass, idempotencyKey: identifier(action.idempotencyKey, "Safety idempotency key"), actionHash: hash(action.actionHash, "Safety action hash"), costs: { monetaryAmountMinor: nonNegative(costs.monetaryAmountMinor, "Safety monetary amount", Number.MAX_SAFE_INTEGER), requests: nonNegative(costs.requests, "Safety request count", Number.MAX_SAFE_INTEGER), messages: nonNegative(costs.messages, "Safety message count", Number.MAX_SAFE_INTEGER), mutations: nonNegative(costs.mutations, "Safety mutation count", Number.MAX_SAFE_INTEGER), deletes: nonNegative(costs.deletes, "Safety delete count", Number.MAX_SAFE_INTEGER), tokenCost: nonNegative(costs.tokenCost, "Safety token cost", Number.MAX_SAFE_INTEGER) } };
}
function validateScope(value: unknown): SafetyScope { const scope = object(value, "Safety scope is invalid."); exactKeys(scope, ["kind", "id"], "Safety scope", ["id"]); if (!SAFETY_SCOPE_KINDS.includes(scope.kind as SafetyScopeKind)) throw new SafetyControllerError("Safety scope kind is invalid."); if (scope.kind === "global") { if (scope.id !== undefined) throw new SafetyControllerError("Global safety scope cannot have an id."); return { kind: "global" }; } if (scope.id === undefined) throw new SafetyControllerError("Scoped safety control requires an id."); return { kind: scope.kind as Exclude<SafetyScopeKind, "global">, id: identifier(scope.id, "Safety scope id") }; }
function validateOperator(value: unknown): SafetyOperator { const operator = object(value, "Emergency operator is invalid."); exactKeys(operator, ["id", "principalId", "permissions"], "Emergency operator"); const permissions = array(operator.permissions, "Emergency operator permissions", 8).map((permission) => { if (permission !== "safety.stop" && permission !== "safety.reenable" && permission !== "safety.configure" && permission !== "safety.inspect") throw new SafetyControllerError("Emergency operator permission is invalid."); return permission as SafetyOperatorPermission; }); unique(permissions, "Emergency operator permissions"); return { id: identifier(operator.id, "Emergency operator id"), principalId: identifier(operator.principalId, "Emergency operator principal id"), permissions }; }
function validateLedger(value: unknown): SafetyControllerState["ledger"][number] { const entry = object(value, "Safety ledger entry is invalid."); exactKeys(entry, ["key", "action", "status", "admittedAt", "completedAt", "outcome"], "Safety ledger entry", ["completedAt", "outcome"]); if (entry.status !== "reserved" && entry.status !== "completed") throw new SafetyControllerError("Safety ledger status is invalid."); const action = validateAction(entry.action); const completedAt = entry.completedAt === undefined ? undefined : timestamp(entry.completedAt, "Safety completion time"); const outcome = entry.outcome === undefined ? undefined : validateOutcome(entry.outcome); if (entry.status === "completed" && (completedAt === undefined || outcome === undefined)) throw new SafetyControllerError("Completed safety ledger entry is invalid."); if (entry.status === "reserved" && (completedAt !== undefined || outcome !== undefined)) throw new SafetyControllerError("Reserved safety ledger entry is invalid."); const key = text(entry.key, "Safety ledger key", 300); if (key !== ledgerKey(action)) throw new SafetyControllerError("Safety ledger key does not match its action."); return { key, action, status: entry.status, admittedAt: timestamp(entry.admittedAt, "Safety admission time"), ...(completedAt === undefined ? {} : { completedAt }), ...(outcome === undefined ? {} : { outcome }) }; }
function validateOutcome(value: unknown): NonNullable<SafetyControllerState["ledger"][number]["outcome"]> { const outcome = object(value, "Safety action outcome is invalid."); exactKeys(outcome, ["success", "policyViolation", "reconciliationMismatch", "latencyMs", "reason"], "Safety action outcome", ["policyViolation", "reconciliationMismatch", "reason"]); if (typeof outcome.success !== "boolean" || (outcome.policyViolation !== undefined && typeof outcome.policyViolation !== "boolean") || (outcome.reconciliationMismatch !== undefined && typeof outcome.reconciliationMismatch !== "boolean")) throw new SafetyControllerError("Safety action outcome flags are invalid."); return { success: outcome.success, policyViolation: outcome.policyViolation ?? false, reconciliationMismatch: outcome.reconciliationMismatch ?? false, latencyMs: nonNegative(outcome.latencyMs, "Safety action latency", 24 * 60 * 60 * 1000), ...(outcome.reason === undefined ? {} : { reason: text(outcome.reason, "Safety action outcome reason", 200) }) }; }
function validateQueueItem(value: unknown): SafetyQueueItem { const item = object(value, "Safety queue item is invalid."); exactKeys(item, ["id", "action", "queuedAt"], "Safety queue item"); return { id: identifier(item.id, "Safety queue id"), action: validateAction(item.action), queuedAt: timestamp(item.queuedAt, "Safety queue time") }; }
function validateDeadLetter(value: unknown): SafetyDeadLetter { const item = object(value, "Safety dead-letter item is invalid."); exactKeys(item, ["id", "action", "queuedAt", "reason", "deadLetteredAt"], "Safety dead-letter item"); return { id: identifier(item.id, "Safety queue id"), action: validateAction(item.action), queuedAt: timestamp(item.queuedAt, "Safety queue time"), reason: text(item.reason, "Safety dead-letter reason", 200), deadLetteredAt: timestamp(item.deadLetteredAt, "Safety dead-letter time") }; }
function validateAudit(value: unknown): SafetyAuditRecord { const record = object(value, "Safety audit record is invalid."); exactKeys(record, ["sequence", "event", "subject", "reason", "actorPrincipalId", "timestamp", "previousHash", "recordHash"], "Safety audit record", ["actorPrincipalId"]); const base = { sequence: positive(record.sequence, "Safety audit sequence", MAX_AUDIT), event: text(record.event, "Safety audit event", 80), subject: text(record.subject, "Safety audit subject", 300), reason: text(record.reason, "Safety audit reason", 200), ...(record.actorPrincipalId === undefined ? {} : { actorPrincipalId: identifier(record.actorPrincipalId, "Safety audit actor") }), timestamp: timestamp(record.timestamp, "Safety audit time"), previousHash: hash(record.previousHash, "Safety audit previous hash") }; if (hash(record.recordHash, "Safety audit record hash") !== sha256(canonical(base))) throw new SafetyControllerError("Safety audit record hash is invalid."); return { ...base, recordHash: record.recordHash as string }; }
function validateAuditChain(anchor: string, audit: SafetyAuditRecord[]): void { let previous = anchor; let sequence = 1; for (const record of audit) { if (record.sequence !== sequence || record.previousHash !== previous) throw new SafetyControllerError("Safety audit chain is invalid."); previous = record.recordHash; sequence += 1; } }
function setSwitch(state: SafetyControllerState, scope: SafetyScope, enabled: boolean, reason: string, principalId: string, now: string): void { const existing = state.switches.find((candidate) => sameScope(candidate.scope, scope)); if (existing === undefined) { if (state.switches.length >= MAX_CONTROLS) throw new SafetyControllerError("Safety switch limit was reached."); state.switches.push({ scope, enabled, reason, changedBy: principalId, changedAt: now }); } else { existing.enabled = enabled; existing.reason = reason; existing.changedBy = principalId; existing.changedAt = now; } }
function assertActionAllowed(state: SafetyControllerState, action: SafetyAction, now: string): void { const stopped = state.switches.find((control) => control.enabled && scopeMatches(control.scope, action)); if (stopped !== undefined) throw new SafetyControllerError(`Kill switch is active for ${scopeKey(stopped.scope)}.`); const circuit = state.circuits.find((candidate) => candidate.state === "open" && scopeMatches(candidate.scope, action)); if (circuit !== undefined) throw new SafetyControllerError(`Safety circuit breaker is open: ${circuit.id}.`); for (const circuitCandidate of state.circuits) if (circuitCandidate.state === "closed" && scopeMatches(circuitCandidate.scope, action)) evaluateCircuit(state, circuitCandidate, now); const opened = state.circuits.find((candidate) => candidate.state === "open" && scopeMatches(candidate.scope, action)); if (opened !== undefined) throw new SafetyControllerError(`Safety circuit breaker is open: ${opened.id}.`); }
function assertBudgets(state: SafetyControllerState, action: SafetyAction, now: string): void { for (const budget of state.budgets) { if (!scopeMatches(budget.scope, action)) continue; const windowEntries = state.ledger.filter((entry) => scopeMatches(budget.scope, entry.action) && Date.parse(entry.admittedAt) >= Date.parse(now) - budget.windowMs); const velocityEntries = state.ledger.filter((entry) => scopeMatches(budget.scope, entry.action) && Date.parse(entry.admittedAt) >= Date.parse(now) - budget.velocityWindowMs); const totals = sumCosts(windowEntries.map((entry) => entry.action.costs)); const velocity = sumCosts(velocityEntries.map((entry) => entry.action.costs)).requests; const concurrent = windowEntries.filter((entry) => entry.status === "reserved").length; for (const key of ["monetaryAmountMinor", "requests", "messages", "mutations", "deletes", "tokenCost"] as const) if (budget.limits[key] !== undefined && totals[key] + action.costs[key] > budget.limits[key]!) throw new SafetyControllerError(`Safety budget exceeded: ${budget.id} ${key}.`); if (budget.limits.concurrency !== undefined && concurrent + 1 > budget.limits.concurrency) throw new SafetyControllerError(`Safety budget exceeded: ${budget.id} concurrency.`); if (budget.limits.velocity !== undefined && velocity + action.costs.requests > budget.limits.velocity) throw new SafetyControllerError(`Safety velocity limit exceeded: ${budget.id}.`); } }
function evaluateCircuits(state: SafetyControllerState, action: SafetyAction, now: string): void { for (const circuit of state.circuits) if (circuit.state === "closed" && scopeMatches(circuit.scope, action)) evaluateCircuit(state, circuit, now); }
function evaluateCircuit(state: SafetyControllerState, circuit: SafetyCircuit, now: string): void { const entries = state.ledger.filter((entry) => entry.status === "completed" && entry.completedAt !== undefined && entry.outcome !== undefined && scopeMatches(circuit.scope, entry.action) && Date.parse(entry.completedAt) >= Date.parse(now) - circuit.windowMs); if (entries.length < circuit.minimumSamples) return; const failures = entries.filter((entry) => !entry.outcome!.success).length; const violations = entries.filter((entry) => entry.outcome!.policyViolation).length; const mismatches = entries.filter((entry) => entry.outcome!.reconciliationMismatch).length; const latencyExceeded = entries.some((entry) => entry.outcome!.latencyMs > circuit.maxLatencyMs); const reason = rateBps(failures, entries.length) > circuit.maxFailureRateBps ? "failure rate exceeded" : violations > circuit.maxPolicyViolations ? "policy violation threshold exceeded" : mismatches > circuit.maxReconciliationMismatches ? "reconciliation mismatch threshold exceeded" : latencyExceeded ? "latency threshold exceeded" : undefined; if (reason !== undefined) { circuit.state = "open"; circuit.openedAt = now; circuit.reason = reason; appendAudit(state, "circuit.opened", circuit.id, reason, now); } }
function deadLetterMatchingQueued(state: SafetyControllerState, scope: SafetyScope, reason: string, now: string): void { const remaining: SafetyQueueItem[] = []; for (const item of state.queue) { if (scopeMatches(scope, item.action)) { addDeadLetter(state, item, `kill switch: ${reason}`, now); appendAudit(state, "queue.dead_lettered", item.id, "kill switch stopped queued action", now); } else remaining.push(item); } state.queue = remaining; }
function addDeadLetter(state: SafetyControllerState, item: SafetyQueueItem, reason: string, now: string): void { if (state.deadLetters.length >= MAX_DEAD_LETTERS) throw new SafetyControllerError("Safety dead-letter queue limit was reached."); state.deadLetters.push({ ...item, reason: text(reason, "Safety dead-letter reason", 200), deadLetteredAt: now }); }
function findLedger(state: SafetyControllerState, key: string): SafetyControllerState["ledger"][number] { const entry = state.ledger.find((candidate) => candidate.key === key); if (entry === undefined) throw new SafetyControllerError("Safety lease was not found."); return entry; }
function scopeMatches(scope: SafetyScope, action: SafetyAction): boolean { return scope.kind === "global" || scope.id === scopeValue(scope.kind, action); }
function scopeValue(kind: Exclude<SafetyScopeKind, "global">, action: SafetyAction): string { switch (kind) { case "organization": return action.organizationId; case "project": return action.projectId; case "environment": return action.environment; case "agent": return action.actorId; case "workload": return action.workloadId; case "provider": return action.provider; case "operation": return action.operation; case "risk_class": return action.riskClass; } }
function scopeKey(scope: SafetyScope): string { return scope.kind === "global" ? "global" : `${scope.kind}:${scope.id}`; }
function sameScope(left: SafetyScope, right: SafetyScope): boolean { return left.kind === right.kind && left.id === right.id; }
function ledgerKey(action: SafetyAction): string { return `${action.idempotencyKey}:${action.actionHash}`; }
function sumCosts(values: SafetyAction["costs"][]): SafetyAction["costs"] { return values.reduce((total, value) => ({ monetaryAmountMinor: total.monetaryAmountMinor + value.monetaryAmountMinor, requests: total.requests + value.requests, messages: total.messages + value.messages, mutations: total.mutations + value.mutations, deletes: total.deletes + value.deletes, tokenCost: total.tokenCost + value.tokenCost }), { monetaryAmountMinor: 0, requests: 0, messages: 0, mutations: 0, deletes: 0, tokenCost: 0 }); }
function appendAudit(state: SafetyControllerState, event: string, subject: string, reason: string, timestampValue: string, actorPrincipalId?: string): void { if (state.audit.length >= MAX_AUDIT) throw new SafetyControllerError("Safety audit limit was reached."); const previousHash = state.audit.at(-1)?.recordHash ?? state.auditAnchor; const base = { sequence: state.audit.length + 1, event: text(event, "Safety audit event", 80), subject: text(subject, "Safety audit subject", 300), reason: text(reason, "Safety audit reason", 200), ...(actorPrincipalId === undefined ? {} : { actorPrincipalId: identifier(actorPrincipalId, "Safety audit actor") }), timestamp: timestampValue, previousHash }; state.audit.push({ ...base, recordHash: sha256(canonical(base)) }); }
function boundedMs(value: unknown, label: string): number { return positive(value, label, 30 * 24 * 60 * 60 * 1000); }
function positive(value: unknown, label: string, max: number): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new SafetyControllerError(`${label} is invalid.`); return value; }
function nonNegative(value: unknown, label: string, max: number): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new SafetyControllerError(`${label} is invalid.`); return value; }
function bps(value: unknown, label: string): number { return nonNegative(value, label, 10_000); }
function rateBps(count: number, total: number): number { return total === 0 ? 0 : Math.floor((count * 10_000) / total); }
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || !IDENTIFIER.test(value) || sanitizeSecretString(value) !== value) throw new SafetyControllerError(`${label} must be a safe identifier.`); return value; }
function hash(value: unknown, label: string): string { if (typeof value !== "string" || !HASH.test(value)) throw new SafetyControllerError(`${label} must be a SHA-256 hash.`); return value; }
function timestamp(value: unknown, label: string): string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new SafetyControllerError(`${label} must be an ISO UTC timestamp.`); return value; }
function text(value: unknown, label: string, max: number): string { if (typeof value !== "string" || value.trim() === "" || value.length > max || /[\u0000-\u001f]/.test(value) || sanitizeSecretString(value) !== value) throw new SafetyControllerError(`${label} is invalid.`); return value.trim(); }
function object(value: unknown, message: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SafetyControllerError(message); return value as Record<string, unknown>; }
function array(value: unknown, label: string, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new SafetyControllerError(`${label} is invalid.`); return value; }
function exactKeys(value: Record<string, unknown>, keys: string[], label: string, optional: string[] = []): void { for (const key of Object.keys(value)) if (!keys.includes(key) || (value[key] === undefined && !optional.includes(key))) throw new SafetyControllerError(`${label} contains unsupported field: ${key}`); }
function unique(values: string[], label: string): void { if (new Set(values).size !== values.length) throw new SafetyControllerError(`${label} must be unique.`); }
function canonical(value: unknown): string { if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; throw new SafetyControllerError("Safety data must be JSON."); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function clone<T>(value: T): T { return structuredClone(value); }
function isErrorCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
