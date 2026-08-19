import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { createLocalSafetyController, type LocalSafetyController, type SafetyAction } from "../safety/index.js";
import { sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";
import { inspectWorld, runSubscriptionFailureWorkflow } from "../worlds/index.js";

const ACTION_SCHEMA_VERSION = 1;
const ACTION_KIND = "ghostapi.action";
const APPROVAL_KIND = "ghostapi.action-approval";
const RECORD_KIND = "ghostapi.action-record";
const MAX_ACTION_BYTES = 128 * 1024;
const MAX_RECEIPTS = 20;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const approvalInboxCapabilities = new WeakSet<object>();

export type ActionRiskClass = "read" | "write" | "money_movement" | "external_communication" | "delete" | "deploy";
export type ActionReversibility = "none" | "compensatable";
export type ActionReceiptStatus = "requested" | "attempted" | "committed" | "verified" | "failed";

export type ActionEnvelope = {
  schemaVersion: 1;
  kind: "ghostapi.action";
  actionId: string;
  idempotencyKey: string;
  actor: { id: string; workloadId: string; type: "agent" | "service" };
  project: { id: string; environment: "synthetic" };
  provider: "ghostapi-synthetic";
  operation: string;
  resource: { type: "synthetic-world"; id: string };
  arguments: { worldId: string };
  expectedSideEffects: readonly string[];
  riskClass: ActionRiskClass;
  reversibility: ActionReversibility;
  policy: { version: number; hash: string };
  evidence: { hash: string };
  expiresAt: string;
  nonce: string;
};

export type ActionApproval = {
  schemaVersion: 1;
  kind: "ghostapi.action-approval";
  approvalId: string;
  actionHash: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  nonce: string;
};

export type ActionExecutionReceipt = {
  receiptId: string;
  actionId: string;
  actionHash: string;
  status: ActionReceiptStatus;
  timestamp: string;
  providerRequestId?: string;
  result?: { worldId: string; subscriptionId: string; syntheticReceiptId: string };
  failure?: { code: "execution_error" | "unknown_outcome" | "verification_failed"; retrySafe: false };
  previousReceiptHash: string;
  receiptHash: string;
};

export type StoredAction = {
  schemaVersion: 1;
  kind: "ghostapi.action-record";
  envelope: ActionEnvelope;
  actionHash: string;
  approval: ActionApproval;
  receipts: ActionExecutionReceipt[];
};

export type ActionExecutionIdentity = { actorId: string; workloadId: string };
export type ActionPolicyCheck = { version: number; hash: string; allowed: boolean };

export type ActionExecutionAdapter = {
  provider: ActionEnvelope["provider"];
  supports(operation: string): boolean;
  plan(action: ActionEnvelope): Promise<void>;
  simulate(action: ActionEnvelope): Promise<void>;
  execute(action: ActionEnvelope, controls?: { commit<T>(operation: () => Promise<T>): Promise<T> }): Promise<{ outcome: "committed"; providerRequestId: string; result: { worldId: string; subscriptionId: string; syntheticReceiptId: string } } | { outcome: "unknown" }>;
  verify(action: ActionEnvelope): Promise<{ committed: boolean; providerRequestId?: string; result?: { worldId: string; subscriptionId: string; syntheticReceiptId: string } }>;
  compensate?: (action: ActionEnvelope) => Promise<void>;
};

export type ActionGatewayOptions = {
  now?: () => Date;
  pathForAction?: (actionId: string) => string;
  adapter?: ActionExecutionAdapter;
  safetyController?: LocalSafetyController;
};

type ApprovalInboxCapability = object;

export class ActionGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionGatewayError";
  }
}

export function canonicalizeActionEnvelope(value: unknown): string {
  return canonicalJson(validateActionEnvelope(value));
}

export function actionHash(value: unknown): string {
  return sha256(canonicalizeActionEnvelope(value));
}

export function actionApprovalHash(value: unknown): string {
  return sha256(canonicalJson(validateActionApproval(value)));
}

export function validateActionEnvelope(value: unknown): ActionEnvelope {
  const action = object(value, "Action envelope must be an object.");
  exactKeys(action, ["schemaVersion", "kind", "actionId", "idempotencyKey", "actor", "project", "provider", "operation", "resource", "arguments", "expectedSideEffects", "riskClass", "reversibility", "policy", "evidence", "expiresAt", "nonce"], "Action envelope");
  if (action.schemaVersion !== ACTION_SCHEMA_VERSION || action.kind !== ACTION_KIND) throw new ActionGatewayError("Unsupported action envelope schema.");
  const actor = object(action.actor, "Action actor is invalid.");
  exactKeys(actor, ["id", "workloadId", "type"], "Action actor");
  if (actor.type !== "agent" && actor.type !== "service") throw new ActionGatewayError("Action actor type is invalid.");
  const project = object(action.project, "Action project is invalid.");
  exactKeys(project, ["id", "environment"], "Action project");
  if (project.environment !== "synthetic") throw new ActionGatewayError("Only the synthetic action environment is available.");
  if (action.provider !== "ghostapi-synthetic") throw new ActionGatewayError("Unknown action provider.");
  const resource = object(action.resource, "Action resource is invalid.");
  exactKeys(resource, ["type", "id"], "Action resource");
  if (resource.type !== "synthetic-world") throw new ActionGatewayError("Action resource type is invalid.");
  const args = object(action.arguments, "Action arguments are invalid.");
  exactKeys(args, ["worldId"], "Action arguments");
  const operation = identifier(action.operation, "Action operation");
  const sideEffects = action.expectedSideEffects;
  const expected: ActionEnvelope["expectedSideEffects"] = ["stripe.subscription.past_due", "email.subscription_payment_failed", "github.recovery_issue", "generic_rest.payment_failed"];
  if (!Array.isArray(sideEffects) || sideEffects.length > 16 || sideEffects.some((value) => typeof value !== "string" || !IDENTIFIER.test(value) || sanitizeSecretString(value) !== value) || new Set(sideEffects).size !== sideEffects.length) throw new ActionGatewayError("Action expected side effects must be a bounded unique list of safe identifiers.");
  if (operation === "synthetic.subscription_failure" && (sideEffects.length !== expected.length || sideEffects.some((value, index) => value !== expected[index]))) throw new ActionGatewayError("Action expected side effects are invalid for the synthetic operation.");
  if (action.riskClass !== "read" && action.riskClass !== "write" && action.riskClass !== "money_movement" && action.riskClass !== "external_communication" && action.riskClass !== "delete" && action.riskClass !== "deploy") throw new ActionGatewayError("Action risk class is invalid.");
  if (action.reversibility !== "none" && action.reversibility !== "compensatable") throw new ActionGatewayError("Action reversibility is invalid.");
  const policy = object(action.policy, "Action policy reference is invalid.");
  exactKeys(policy, ["version", "hash"], "Action policy reference");
  const evidence = object(action.evidence, "Action evidence reference is invalid.");
  exactKeys(evidence, ["hash"], "Action evidence reference");
  const worldId = identifier(args.worldId, "Action world id");
  if (resource.id !== worldId) throw new ActionGatewayError("Action resource and normalized world argument must match.");
  return {
    schemaVersion: 1,
    kind: "ghostapi.action",
    actionId: identifier(action.actionId, "Action id"),
    idempotencyKey: identifier(action.idempotencyKey, "Action idempotency key"),
    actor: { id: identifier(actor.id, "Action actor id"), workloadId: identifier(actor.workloadId, "Action workload id"), type: actor.type },
    project: { id: identifier(project.id, "Action project id"), environment: "synthetic" },
    provider: "ghostapi-synthetic",
    operation,
    resource: { type: "synthetic-world", id: worldId },
    arguments: { worldId },
    expectedSideEffects: [...sideEffects] as string[],
    riskClass: action.riskClass,
    reversibility: action.reversibility,
    policy: { version: positiveInteger(policy.version, "Action policy version"), hash: hash(policy.hash, "Action policy hash") },
    evidence: { hash: hash(evidence.hash, "Action evidence hash") },
    expiresAt: futureTimestamp(action.expiresAt, "Action expiry"),
    nonce: identifier(action.nonce, "Action nonce")
  };
}

export function validateActionApproval(value: unknown): ActionApproval {
  const approval = object(value, "Action approval must be an object.");
  exactKeys(approval, ["schemaVersion", "kind", "approvalId", "actionHash", "approvedBy", "approvedAt", "expiresAt", "nonce"], "Action approval");
  if (approval.schemaVersion !== ACTION_SCHEMA_VERSION || approval.kind !== APPROVAL_KIND) throw new ActionGatewayError("Unsupported action approval schema.");
  const approvedAt = timestamp(approval.approvedAt, "Action approval timestamp");
  const expiresAt = futureTimestamp(approval.expiresAt, "Action approval expiry");
  if (Date.parse(expiresAt) <= Date.parse(approvedAt)) throw new ActionGatewayError("Action approval must expire after it was issued.");
  return { schemaVersion: 1, kind: "ghostapi.action-approval", approvalId: identifier(approval.approvalId, "Action approval id"), actionHash: hash(approval.actionHash, "Action approval hash"), approvedBy: identifier(approval.approvedBy, "Action approver id"), approvedAt, expiresAt, nonce: identifier(approval.nonce, "Action approval nonce") };
}

export function createSyntheticActionAdapter(): ActionExecutionAdapter {
  return {
    provider: "ghostapi-synthetic",
    supports: (operation) => operation === "synthetic.subscription_failure",
    async plan(action) {
      if (action.resource.id !== action.arguments.worldId) throw new ActionGatewayError("Synthetic action resource does not match normalized arguments.");
    },
    async simulate(action) {
      await inspectWorld(action.arguments.worldId);
    },
    async execute(action, controls) {
      const receipt = await runSubscriptionFailureWorkflow(action.arguments.worldId, action.actionId, controls?.commit);
      return { outcome: "committed", providerRequestId: `synthetic_${receipt.actionId}`, result: { worldId: action.arguments.worldId, subscriptionId: receipt.subscriptionId, syntheticReceiptId: receipt.actionId } };
    },
    async verify(action) {
      const world = await inspectWorld(action.arguments.worldId);
      const receipt = world.state.receipts.find((candidate) => candidate.actionId === action.actionId);
      return receipt === undefined
        ? { committed: false }
        : { committed: true, providerRequestId: `synthetic_${receipt.actionId}`, result: { worldId: action.arguments.worldId, subscriptionId: receipt.subscriptionId, syntheticReceiptId: receipt.actionId } };
    }
  };
}

/** Internal capability used only by the local approval inbox execution path. */
export function createApprovalInboxCapability(): ApprovalInboxCapability {
  const capability = Object.freeze({});
  approvalInboxCapabilities.add(capability);
  return capability;
}

export class LocalActionGateway {
  private readonly now: () => Date;
  private readonly pathForAction: (actionId: string) => string;
  private readonly adapter: ActionExecutionAdapter;
  private readonly safetyController: LocalSafetyController;

  constructor(options: ActionGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.pathForAction = options.pathForAction ?? getActionPath;
    this.adapter = options.adapter ?? createSyntheticActionAdapter();
    this.safetyController = options.safetyController ?? createLocalSafetyController({ now: this.now });
  }

  async submit(actionValue: unknown, approvalValue: unknown, policy: ActionPolicyCheck): Promise<StoredAction> {
    return this.submitInternal(actionValue, approvalValue, policy, undefined);
  }

  async submitFromApprovalInbox(actionValue: unknown, approvalValue: unknown, policy: ActionPolicyCheck, capability: unknown): Promise<StoredAction> {
    return this.submitInternal(actionValue, approvalValue, policy, requireApprovalInboxCapability(capability));
  }

  private async submitInternal(actionValue: unknown, approvalValue: unknown, policy: ActionPolicyCheck, capability: ApprovalInboxCapability | undefined): Promise<StoredAction> {
    const action = validateActionEnvelope(actionValue);
    const approval = validateActionApproval(approvalValue);
    assertApprovalSubmissionPath(approval, capability);
    const current = this.now().toISOString();
    if (Date.parse(action.expiresAt) <= Date.parse(current)) throw new ActionGatewayError("Action has expired.");
    verifyApproval(action, approval, current);
    verifyPolicy(action, policy);
    const actionDigest = actionHash(action);
    const path = this.pathForAction(action.actionId);
    return withFileLock(path, async () => {
      const existing = await readStoredAction(path, false);
      if (existing !== null) {
        if (existing.actionHash === actionDigest && actionApprovalHash(existing.approval) === actionApprovalHash(approval)) return existing;
        throw new ActionGatewayError("Action id already exists with a different immutable envelope or approval.");
      }
      const record: StoredAction = { schemaVersion: 1, kind: "ghostapi.action-record", envelope: action, actionHash: actionDigest, approval, receipts: [] };
      record.receipts.push(createReceipt(record, "requested", current));
      await writeStoredAction(path, record);
      return record;
    });
  }

  async inspect(actionId: string): Promise<StoredAction> {
    return readStoredAction(this.pathForAction(identifier(actionId, "Action id")), true) as Promise<StoredAction>;
  }

  async execute(actionValue: unknown, identity: ActionExecutionIdentity, policy: ActionPolicyCheck): Promise<ActionExecutionReceipt> {
    return this.executeInternal(actionValue, identity, policy, undefined);
  }

  async executeFromApprovalInbox(actionValue: unknown, identity: ActionExecutionIdentity, policy: ActionPolicyCheck, capability: unknown): Promise<ActionExecutionReceipt> {
    return this.executeInternal(actionValue, identity, policy, requireApprovalInboxCapability(capability));
  }

  private async executeInternal(actionValue: unknown, identity: ActionExecutionIdentity, policy: ActionPolicyCheck, capability: ApprovalInboxCapability | undefined): Promise<ActionExecutionReceipt> {
    const requested = validateActionEnvelope(actionValue);
    const path = this.pathForAction(requested.actionId);
    return withFileLock(path, async () => {
      const record = await readStoredAction(path, true);
      if (record === null) throw new ActionGatewayError("Action was not submitted.");
      assertApprovalExecutionPath(record.approval, capability);
      const current = this.now().toISOString();
      if (actionHash(requested) !== record.actionHash || canonicalizeActionEnvelope(requested) !== canonicalizeActionEnvelope(record.envelope)) throw new ActionGatewayError("Action envelope changed after approval; execution is blocked.");
      verifyApproval(record.envelope, record.approval, current);
      verifyPolicy(record.envelope, policy);
      if (identity.actorId !== record.envelope.actor.id || identity.workloadId !== record.envelope.actor.workloadId) throw new ActionGatewayError("Execution identity does not match the approved action.");
      if (!this.adapter.supports(record.envelope.operation)) throw new ActionGatewayError(`Execution adapter does not support action operation: ${record.envelope.operation}`);
      if (Date.parse(record.envelope.expiresAt) <= Date.parse(current)) throw new ActionGatewayError("Action has expired.");
      const verified = findLatestReceipt(record.receipts, "verified");
      if (verified !== undefined) return verified;
      const committed = findLatestReceipt(record.receipts, "committed");
      if (committed !== undefined) {
        const reconciliation = await this.adapter.verify(record.envelope);
        if (!reconciliation.committed || reconciliation.providerRequestId === undefined || reconciliation.result === undefined) throw new ActionGatewayError("Committed action verification is incomplete; execution will not retry without idempotency proof.");
        const verifiedReceipt = createReceipt(record, "verified", current, reconciliation.providerRequestId, reconciliation.result);
        appendReceipt(record, verifiedReceipt);
        await writeStoredAction(path, record);
        return verifiedReceipt;
      }
      const attempted = findLatestReceipt(record.receipts, "attempted");
      if (attempted !== undefined) {
        const reconciliation = await this.adapter.verify(record.envelope);
        if (!reconciliation.committed || reconciliation.providerRequestId === undefined || reconciliation.result === undefined) throw new ActionGatewayError("Prior action outcome is unknown; execution will not retry without idempotency proof.");
        appendReceipt(record, createReceipt(record, "committed", current, reconciliation.providerRequestId, reconciliation.result));
        const verifiedReceipt = createReceipt(record, "verified", current, reconciliation.providerRequestId, reconciliation.result);
        appendReceipt(record, verifiedReceipt);
        await writeStoredAction(path, record);
        return verifiedReceipt;
      }
      await this.adapter.plan(record.envelope);
      await this.adapter.simulate(record.envelope);
      const safety = await this.safetyController.admit(safetyAction(record.envelope, record.actionHash));
      if (safety.replay) throw new ActionGatewayError("Safety controller replay was reached before a verified action receipt.");
      appendReceipt(record, createReceipt(record, "attempted", current));
      await writeStoredAction(path, record);
      let execution: Awaited<ReturnType<ActionExecutionAdapter["execute"]>>;
      try {
        execution = await this.adapter.execute(record.envelope, { commit: safety.commit });
      } catch {
        await safety.complete({ success: false, latencyMs: 0, reason: "synthetic execution failed or was stopped" });
        const failed = createReceipt(record, "failed", this.now().toISOString(), undefined, undefined, { code: "execution_error", retrySafe: false });
        appendReceipt(record, failed);
        await writeStoredAction(path, record);
        throw new ActionGatewayError("Action execution failed; it was not automatically retried.");
      }
      if (execution.outcome === "unknown") {
        await safety.complete({ success: false, latencyMs: 0, reason: "synthetic execution outcome is unknown" });
        const failed = createReceipt(record, "failed", this.now().toISOString(), undefined, undefined, { code: "unknown_outcome", retrySafe: false });
        appendReceipt(record, failed);
        await writeStoredAction(path, record);
        throw new ActionGatewayError("Action provider outcome is unknown; it was not automatically retried.");
      }
      appendReceipt(record, createReceipt(record, "committed", this.now().toISOString(), execution.providerRequestId, execution.result));
      const verification = await this.adapter.verify(record.envelope);
      if (!verification.committed || verification.providerRequestId === undefined || verification.result === undefined) {
        await safety.complete({ success: false, reconciliationMismatch: true, latencyMs: 0, reason: "synthetic verification did not prove the result" });
        const failed = createReceipt(record, "failed", this.now().toISOString(), execution.providerRequestId, execution.result, { code: "verification_failed", retrySafe: false });
        appendReceipt(record, failed);
        await writeStoredAction(path, record);
        throw new ActionGatewayError("Action committed but verification did not prove its result; it was not automatically retried.");
      }
      const verifiedReceipt = createReceipt(record, "verified", this.now().toISOString(), verification.providerRequestId, verification.result);
      appendReceipt(record, verifiedReceipt);
      await writeStoredAction(path, record);
      await safety.complete({ success: true, latencyMs: 0 });
      return verifiedReceipt;
    });
  }

  async compensate(actionId: string): Promise<never> {
    const action = await this.inspect(actionId);
    if (this.adapter.compensate === undefined || action.envelope.reversibility !== "compensatable") throw new ActionGatewayError("Compensation is unsupported for this action; no rollback is claimed.");
    await this.adapter.compensate(action.envelope);
    throw new ActionGatewayError("Compensation adapters must return a durable compensation receipt before this operation can be exposed.");
  }
}

function safetyAction(action: ActionEnvelope, actionDigest: string): SafetyAction {
  return {
    organizationId: "ghostapi-local",
    projectId: action.project.id,
    environment: action.project.environment,
    actorId: action.actor.id,
    workloadId: action.actor.workloadId,
    provider: action.provider,
    operation: action.operation,
    riskClass: action.riskClass,
    idempotencyKey: action.idempotencyKey,
    actionHash: actionDigest,
    costs: { monetaryAmountMinor: 0, requests: 1, messages: 1, mutations: 1, deletes: 0, tokenCost: 0 }
  };
}

export function createLocalActionGateway(options: ActionGatewayOptions = {}): LocalActionGateway {
  return new LocalActionGateway(options);
}

export function getActionPath(actionId: string): string {
  return join(getDataPaths().actions, `${identifier(actionId, "Action id")}.action.json`);
}

async function readStoredAction(path: string, required: boolean): Promise<StoredAction | null> {
  await ensurePrivateDirectory(getDataPaths().actions);
  const info = await lstat(path).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
  if (info === null) {
    if (required) throw new ActionGatewayError("Action was not found.");
    return null;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new ActionGatewayError("Action record must be a regular non-symlink file.");
  const source = await readFile(path, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_ACTION_BYTES) throw new ActionGatewayError(`Action record exceeds ${MAX_ACTION_BYTES} bytes.`);
  try {
    return validateStoredAction(JSON.parse(source));
  } catch (error) {
    if (error instanceof ActionGatewayError) throw error;
    throw new ActionGatewayError("Action record is not valid JSON.");
  }
}

async function writeStoredAction(path: string, record: StoredAction): Promise<void> {
  await ensurePrivateDirectory(getDataPaths().actions);
  await atomicWriteJson(path, validateStoredAction(record));
}

export function validateStoredAction(value: unknown): StoredAction {
  const record = object(value, "Action record must be an object.");
  exactKeys(record, ["schemaVersion", "kind", "envelope", "actionHash", "approval", "receipts"], "Action record");
  if (record.schemaVersion !== ACTION_SCHEMA_VERSION || record.kind !== RECORD_KIND) throw new ActionGatewayError("Unsupported action record schema.");
  const envelope = validateActionEnvelope(record.envelope);
  const digest = hash(record.actionHash, "Action record hash");
  if (digest !== actionHash(envelope)) throw new ActionGatewayError("Action record hash does not match its envelope.");
  const approval = validateActionApproval(record.approval);
  verifyApproval(envelope, approval, new Date(0).toISOString(), false);
  const rawReceipts = record.receipts;
  if (!Array.isArray(rawReceipts) || rawReceipts.length < 1 || rawReceipts.length > MAX_RECEIPTS) throw new ActionGatewayError("Action record receipts are invalid.");
  const receipts = rawReceipts.map((receipt, index) => validateReceipt(receipt, envelope.actionId, digest, index === 0 ? receiptGenesisHash(digest) : rawReceipts[index - 1]!.receiptHash as string));
  if (receipts[0]!.status !== "requested") throw new ActionGatewayError("Action record must begin with a requested receipt.");
  return { schemaVersion: 1, kind: "ghostapi.action-record", envelope, actionHash: digest, approval, receipts };
}

function createReceipt(record: StoredAction, status: ActionReceiptStatus, timestamp: string, providerRequestId?: string, result?: ActionExecutionReceipt["result"], failure?: ActionExecutionReceipt["failure"]): ActionExecutionReceipt {
  const previousReceiptHash = record.receipts.length === 0 ? receiptGenesisHash(record.actionHash) : record.receipts.at(-1)!.receiptHash;
  const base = { receiptId: identifier(`receipt-${randomUUID().replace(/-/g, "")}`, "Receipt id"), actionId: record.envelope.actionId, actionHash: record.actionHash, status, timestamp: timestampValue(timestamp, "Action receipt timestamp"), ...(providerRequestId === undefined ? {} : { providerRequestId: identifier(providerRequestId, "Provider request id") }), ...(result === undefined ? {} : { result }), ...(failure === undefined ? {} : { failure }), previousReceiptHash };
  return { ...base, receiptHash: sha256(canonicalJson(base)) };
}

function appendReceipt(record: StoredAction, receipt: ActionExecutionReceipt): void {
  if (record.receipts.length >= MAX_RECEIPTS) throw new ActionGatewayError(`Action receipt limit of ${MAX_RECEIPTS} was reached.`);
  record.receipts.push(receipt);
}

function validateReceipt(value: unknown, actionId: string, actionDigest: string, previousReceiptHash: string): ActionExecutionReceipt {
  const receipt = object(value, "Action receipt is invalid.");
  exactKeys(receipt, ["receiptId", "actionId", "actionHash", "status", "timestamp", "providerRequestId", "result", "failure", "previousReceiptHash", "receiptHash"], "Action receipt");
  if (receipt.actionId !== actionId || receipt.actionHash !== actionDigest || receipt.previousReceiptHash !== previousReceiptHash || (receipt.status !== "requested" && receipt.status !== "attempted" && receipt.status !== "committed" && receipt.status !== "verified" && receipt.status !== "failed")) throw new ActionGatewayError("Action receipt linkage is invalid.");
  const providerRequestId = receipt.providerRequestId === undefined ? undefined : identifier(receipt.providerRequestId, "Provider request id");
  const result = receipt.result === undefined ? undefined : normalizeResult(receipt.result);
  const failure = receipt.failure === undefined ? undefined : normalizeFailure(receipt.failure);
  if ((receipt.status === "committed" || receipt.status === "verified") && (providerRequestId === undefined || result === undefined)) throw new ActionGatewayError("Committed and verified receipts require a provider result.");
  if (receipt.status === "failed" && failure === undefined) throw new ActionGatewayError("Failed receipt requires a failure classification.");
  const status = receipt.status as ActionReceiptStatus;
  const base = { receiptId: identifier(receipt.receiptId, "Receipt id"), actionId, actionHash: actionDigest, status, timestamp: timestampValue(receipt.timestamp, "Action receipt timestamp"), ...(providerRequestId === undefined ? {} : { providerRequestId }), ...(result === undefined ? {} : { result }), ...(failure === undefined ? {} : { failure }), previousReceiptHash };
  if (hash(receipt.receiptHash, "Action receipt hash") !== sha256(canonicalJson(base))) throw new ActionGatewayError("Action receipt hash is invalid.");
  return { ...base, receiptHash: receipt.receiptHash as string };
}

function normalizeResult(value: unknown): NonNullable<ActionExecutionReceipt["result"]> {
  const result = object(value, "Action receipt result is invalid.");
  exactKeys(result, ["worldId", "subscriptionId", "syntheticReceiptId"], "Action receipt result");
  return { worldId: identifier(result.worldId, "Action receipt world id"), subscriptionId: identifier(result.subscriptionId, "Action receipt subscription id"), syntheticReceiptId: identifier(result.syntheticReceiptId, "Action receipt synthetic receipt id") };
}

function normalizeFailure(value: unknown): NonNullable<ActionExecutionReceipt["failure"]> {
  const failure = object(value, "Action receipt failure is invalid.");
  exactKeys(failure, ["code", "retrySafe"], "Action receipt failure");
  if ((failure.code !== "execution_error" && failure.code !== "unknown_outcome" && failure.code !== "verification_failed") || failure.retrySafe !== false) throw new ActionGatewayError("Action receipt failure is invalid.");
  return { code: failure.code, retrySafe: false };
}

function verifyApproval(action: ActionEnvelope, approval: ActionApproval, now: string, enforceExpiry = true): void {
  if (approval.actionHash !== actionHash(action)) throw new ActionGatewayError("Action approval is not bound to the exact canonical action hash.");
  if (approval.approvedBy === action.actor.id || approval.approvedBy === action.actor.workloadId) throw new ActionGatewayError("An action actor cannot approve its own high-risk action.");
  if (enforceExpiry && Date.parse(approval.approvedAt) > Date.parse(now)) throw new ActionGatewayError("Action approval timestamp is in the future.");
  if (enforceExpiry && Date.parse(approval.expiresAt) <= Date.parse(now)) throw new ActionGatewayError("Action approval has expired.");
}

function requireApprovalInboxCapability(value: unknown): ApprovalInboxCapability {
  if (value === null || typeof value !== "object" || !approvalInboxCapabilities.has(value)) throw new ActionGatewayError("Approval inbox capability is invalid.");
  return value;
}

function assertApprovalSubmissionPath(approval: ActionApproval, capability: ApprovalInboxCapability | undefined): void {
  if (approval.approvedBy === "approval-inbox" && capability === undefined) throw new ActionGatewayError("Approval inbox artifacts can be submitted only through the approval inbox.");
}

function assertApprovalExecutionPath(approval: ActionApproval, capability: ApprovalInboxCapability | undefined): void {
  if (approval.approvedBy === "approval-inbox" && capability === undefined) throw new ActionGatewayError("Approval inbox artifacts can be executed only through the approval inbox.");
}

function verifyPolicy(action: ActionEnvelope, policy: ActionPolicyCheck): void {
  if (!policy.allowed) throw new ActionGatewayError("Current policy denies action execution.");
  if (policy.version !== action.policy.version || policy.hash !== action.policy.hash) throw new ActionGatewayError("Current policy reference does not match the approved action.");
}

function receiptGenesisHash(actionDigest: string): string {
  return sha256(`ghostapi.action.receipt.v1:${actionDigest}`);
}

function findLatestReceipt(receipts: readonly ActionExecutionReceipt[], status: ActionReceiptStatus): ActionExecutionReceipt | undefined {
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index]!;
    if (receipt.status === status) return receipt;
  }
  return undefined;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ActionGatewayError(message);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ActionGatewayError(`${label} contains unsupported field: ${key}`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || sanitizeSecretString(value) !== value) throw new ActionGatewayError(`${label} must be a safe stable identifier.`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new ActionGatewayError(`${label} must be a SHA-256 hex digest.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) throw new ActionGatewayError(`${label} must be a positive integer.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  return timestampValue(value, label);
}

function timestampValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ActionGatewayError(`${label} must be an ISO UTC timestamp.`);
  return value;
}

function futureTimestamp(value: unknown, label: string): string {
  return timestampValue(value, label);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ActionGatewayError("Canonical action values must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new ActionGatewayError("Canonical action values must be JSON data.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
