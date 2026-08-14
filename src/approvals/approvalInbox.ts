import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { actionHash, createLocalActionGateway, createSyntheticActionAdapter, validateActionEnvelope, type ActionApproval, type ActionEnvelope, type ActionExecutionIdentity, type ActionExecutionReceipt, type ActionPolicyCheck, type LocalActionGateway } from "../actions/index.js";
import { getDataPaths } from "../config/dataPaths.js";
import { sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";

const SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_REQUESTS = 1_000;
const MAX_DECISIONS = 4;
const MAX_AUDIT = 10_000;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

export type ApprovalRisk = "read" | "create" | "update" | "communicate" | "money_movement" | "delete" | "permission_change" | "deployment";
export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "revoked" | "timed_out" | "expired" | "executing" | "executed" | "execution_failed" | "superseded";

export type ApprovalPolicy = {
  schemaVersion: 1;
  kind: "ghostapi.approval-policy";
  id: string;
  version: number;
  allowedEnvironments: string[];
  allowedActors?: string[];
  allowedResources?: string[];
  maxAmountMinor?: number;
  minimumConfidence: number;
  criticalRisks: ApprovalRisk[];
  velocity: { maxActions: number; windowMs: number };
  approvalTtlMs: number;
  escalationTimeoutMs: number;
};

export type ApprovalContext = { confidence: number; amountMinor?: number };
export type ApprovalApprover = { id: string; independenceKey: string };
export interface ApprovalApproverVerifier { authenticate(identity: unknown): Promise<ApprovalApprover>; }

export type ApprovalDecision = { id: string; kind: "approve" | "reject" | "revoke"; approverId: string; independenceKey: string; reason?: string; decidedAt: string };
export type ApprovalDisplay = {
  intent: string;
  target: string;
  normalizedArgumentDiff: { before: Record<string, never>; after: ActionEnvelope["arguments"] };
  expectedSideEffects: string[];
  reversibility: ActionEnvelope["reversibility"];
  impact: { amountMinor: number | null; amountKnown: boolean; irreversible: boolean };
  policyReason: string[];
  evidenceHash: string;
  simulation: { status: "passed"; summary: string };
};
export type ApprovalRequest = {
  id: string;
  action: ActionEnvelope;
  actionHash: string;
  risk: ApprovalRisk;
  context: ApprovalContext;
  policy: { id: string; version: number; hash: string; requiredApprovals: number };
  display: ApprovalDisplay;
  status: ApprovalRequestStatus;
  createdAt: string;
  expiresAt: string;
  escalationAt: string;
  decisions: ApprovalDecision[];
  artifact?: ActionApproval;
  consumedAt?: string;
  executionReceiptHash?: string;
  supersedesRequestId?: string;
};
export type ApprovalAuditRecord = { sequence: number; event: string; requestId: string; actionHash: string; actionReceiptHash?: string; actorId: string; timestamp: string; previousHash: string; recordHash: string };
export type ApprovalInboxState = { schemaVersion: 1; requests: ApprovalRequest[]; auditAnchor: string; audit: ApprovalAuditRecord[] };
export type ApprovalInboxOptions = { path?: string; now?: () => Date; approverVerifier: ApprovalApproverVerifier; actionGateway?: LocalActionGateway };

export class ApprovalInboxError extends Error {
  constructor(message: string) { super(message); this.name = "ApprovalInboxError"; }
}

export function createLocalApprovalInbox(options: ApprovalInboxOptions): LocalApprovalInbox {
  return new LocalApprovalInbox(options);
}

export class LocalApprovalInbox {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly approverVerifier: ApprovalApproverVerifier;
  private readonly actionGateway: LocalActionGateway;

  constructor(options: ApprovalInboxOptions) {
    this.path = options.path ?? getDataPaths().approvals;
    this.now = options.now ?? (() => new Date());
    this.approverVerifier = options.approverVerifier;
    this.actionGateway = options.actionGateway ?? createLocalActionGateway({ now: this.now });
  }

  async request(actionValue: unknown, policyValue: unknown, contextValue: unknown): Promise<ApprovalRequest> {
    const action = validateActionEnvelope(actionValue);
    const policy = validatePolicy(policyValue);
    const context = validateContext(contextValue);
    const now = this.timestamp();
    if (Date.parse(action.expiresAt) <= Date.parse(now)) throw new ApprovalInboxError("Action has expired.");
    await createSyntheticActionAdapter().plan(action);
    await createSyntheticActionAdapter().simulate(action);
    return this.mutate((state, timestamp) => {
      refresh(state, timestamp);
      const actionDigest = actionHash(action);
      const existing = state.requests.find((request) => request.actionHash === actionDigest && request.status !== "superseded");
      if (existing !== undefined) return clone(existing);
      const decision = evaluate(policy, action, context, state.requests, timestamp);
      if (!decision.allowed) throw new ApprovalInboxError(`Approval policy denies this action: ${decision.reasons.join("; ")}`);
      const expiresAt = new Date(Math.min(Date.parse(action.expiresAt), Date.parse(timestamp) + policy.approvalTtlMs)).toISOString();
      const request: ApprovalRequest = {
        id: identifier(`approval-${randomUUID().replace(/-/g, "")}`, "Approval request id"), action, actionHash: actionDigest, risk: classify(action), context,
        policy: { id: policy.id, version: policy.version, hash: policyHash(policy), requiredApprovals: decision.requiredApprovals },
        display: display(action, context, decision.reasons), status: "pending", createdAt: timestamp, expiresAt,
        escalationAt: new Date(Date.parse(timestamp) + policy.escalationTimeoutMs).toISOString(), decisions: []
      };
      state.requests.push(request);
      appendAudit(state, "request.created", request, action.actor.id, timestamp);
      return clone(request);
    });
  }

  async approve(requestIdValue: string, identity: unknown): Promise<ApprovalRequest> {
    const approver = await this.approverVerifier.authenticate(identity);
    const requestId = identifier(requestIdValue, "Approval request id");
    return this.mutate((state, now) => {
      refresh(state, now);
      const request = findRequest(state, requestId);
      requirePending(request);
      assertIndependent(request, approver);
      if (request.decisions.some((decision) => decision.kind === "approve" && (decision.approverId === approver.id || decision.independenceKey === approver.independenceKey))) throw new ApprovalInboxError("An independent approver can approve this action only once.");
      const decision: ApprovalDecision = { id: identifier(`decision-${randomUUID().replace(/-/g, "")}`, "Approval decision id"), kind: "approve", approverId: approver.id, independenceKey: approver.independenceKey, decidedAt: now };
      request.decisions.push(decision);
      appendAudit(state, "request.approved", request, approver.id, now);
      if (request.decisions.filter((entry) => entry.kind === "approve").length >= request.policy.requiredApprovals) {
        request.status = "approved";
        request.artifact = createArtifact(request, now);
        appendAudit(state, "artifact.issued", request, "approval-inbox", now);
      }
      return clone(request);
    });
  }

  async reject(requestIdValue: string, identity: unknown, reasonValue: string): Promise<ApprovalRequest> {
    return this.decideTerminal(requestIdValue, identity, reasonValue, "reject");
  }

  async revoke(requestIdValue: string, identity: unknown, reasonValue: string): Promise<ApprovalRequest> {
    return this.decideTerminal(requestIdValue, identity, reasonValue, "revoke");
  }

  async editAndResubmit(requestIdValue: string, identity: unknown, replacementAction: unknown, policy: unknown, context: unknown): Promise<ApprovalRequest> {
    const approver = await this.approverVerifier.authenticate(identity);
    const requestId = identifier(requestIdValue, "Approval request id");
    const old = await this.mutate((state, now) => {
      refresh(state, now);
      const request = findRequest(state, requestId);
      if (request.status === "executing" || request.status === "executed" || request.consumedAt !== undefined) throw new ApprovalInboxError("Executed or executing approvals cannot be edited.");
      request.status = "superseded";
      appendAudit(state, "request.superseded", request, approver.id, now);
      return clone(request);
    });
    const next = await this.request(replacementAction, policy, context);
    if (next.actionHash === old.actionHash) throw new ApprovalInboxError("Edit-and-resubmit requires changed normalized action arguments.");
    return this.mutate((state) => {
      const request = findRequest(state, next.id);
      request.supersedesRequestId = old.id;
      return clone(request);
    });
  }

  async execute(requestIdValue: string, identity: ActionExecutionIdentity, actionPolicy: ActionPolicyCheck, policyValue: unknown): Promise<ActionExecutionReceipt> {
    const requestId = identifier(requestIdValue, "Approval request id");
    const policy = validatePolicy(policyValue);
    return withFileLock(this.path, async () => {
      const state = await this.read();
      const now = this.timestamp();
      refresh(state, now);
      const request = findRequest(state, requestId);
      if (request.status !== "approved" || request.artifact === undefined || request.consumedAt !== undefined) throw new ApprovalInboxError("Approval is not active for execution.");
      if (request.policy.id !== policy.id || request.policy.version !== policy.version || request.policy.hash !== policyHash(policy)) throw new ApprovalInboxError("Approval policy changed after approval.");
      const decision = evaluate(policy, request.action, request.context, state.requests, now, request.id);
      if (!decision.allowed || decision.requiredApprovals !== request.policy.requiredApprovals) throw new ApprovalInboxError("Current approval policy no longer authorizes execution.");
      if (identity.actorId !== request.action.actor.id || identity.workloadId !== request.action.actor.workloadId) throw new ApprovalInboxError("Execution identity does not match the approved action.");
      request.consumedAt = now;
      request.status = "executing";
      appendAudit(state, "artifact.consumed", request, identity.actorId, now);
      await this.write(state);
      try {
        await this.actionGateway.submit(request.action, request.artifact, actionPolicy);
        const receipt = await this.actionGateway.execute(request.action, identity, actionPolicy);
        request.status = "executed";
        request.executionReceiptHash = receipt.receiptHash;
        appendAudit(state, "execution.verified", request, identity.actorId, this.timestamp(), receipt.receiptHash);
        await this.write(state);
        return receipt;
      } catch (error) {
        request.status = "execution_failed";
        appendAudit(state, "execution.failed", request, identity.actorId, this.timestamp());
        await this.write(state);
        throw error;
      }
    });
  }

  async get(requestIdValue: string): Promise<ApprovalRequest> {
    const requestId = identifier(requestIdValue, "Approval request id");
    return this.mutate((state, now) => { refresh(state, now); return clone(findRequest(state, requestId)); });
  }

  async list(status?: ApprovalRequestStatus): Promise<ApprovalRequest[]> {
    return this.mutate((state, now) => { refresh(state, now); return state.requests.filter((request) => status === undefined || request.status === status).map(clone); });
  }

  async readStateForTesting(): Promise<ApprovalInboxState> { return this.read(); }

  private async decideTerminal(requestIdValue: string, identity: unknown, reasonValue: string, kind: "reject" | "revoke"): Promise<ApprovalRequest> {
    const approver = await this.approverVerifier.authenticate(identity);
    const requestId = identifier(requestIdValue, "Approval request id");
    const reason = text(reasonValue, "Approval decision reason", 200);
    return this.mutate((state, now) => {
      refresh(state, now);
      const request = findRequest(state, requestId);
      if (request.status === "executing" || request.status === "executed" || request.status === "execution_failed") throw new ApprovalInboxError("Execution has already started; approval cannot be revoked.");
      if (request.status !== "pending" && request.status !== "approved") throw new ApprovalInboxError("Approval is not active.");
      const decision: ApprovalDecision = { id: identifier(`decision-${randomUUID().replace(/-/g, "")}`, "Approval decision id"), kind, approverId: approver.id, independenceKey: approver.independenceKey, reason, decidedAt: now };
      request.decisions.push(decision);
      request.status = kind === "reject" ? "rejected" : "revoked";
      appendAudit(state, kind === "reject" ? "request.rejected" : "request.revoked", request, approver.id, now);
      return clone(request);
    });
  }

  private async read(): Promise<ApprovalInboxState> {
    await ensurePrivateDirectory(dirname(this.path));
    const info = await lstat(this.path).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
    if (info === null) return emptyState();
    if (!info.isFile() || info.isSymbolicLink()) throw new ApprovalInboxError("Approval inbox store must be a regular non-symlink file.");
    const source = await readFile(this.path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_STORE_BYTES) throw new ApprovalInboxError("Approval inbox store exceeds its size limit.");
    try { return validateState(JSON.parse(source)); } catch (error) { if (error instanceof ApprovalInboxError) throw error; throw new ApprovalInboxError("Approval inbox store is not valid JSON."); }
  }

  private async mutate<T>(operation: (state: ApprovalInboxState, now: string) => T): Promise<T> {
    return withFileLock(this.path, async () => { const state = await this.read(); const result = operation(state, this.timestamp()); await this.write(state); return result; });
  }

  private async write(state: ApprovalInboxState): Promise<void> { await atomicWriteJson(this.path, validateState(state)); }
  private timestamp(): string { const value = this.now(); if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ApprovalInboxError("Approval inbox clock is invalid."); return value.toISOString(); }
}

export function createTestApprovalApproverVerifier(): { verifier: ApprovalApproverVerifier; issue(input: ApprovalApprover): ApprovalApprover } {
  const issued = new WeakSet<object>();
  return {
    verifier: { async authenticate(identity: unknown): Promise<ApprovalApprover> { if (identity === null || typeof identity !== "object" || !issued.has(identity)) throw new ApprovalInboxError("Approver identity is not authenticated."); return validateApprover(identity); } },
    issue(input): ApprovalApprover { const result = Object.freeze(validateApprover(input)); issued.add(result); return result; }
  };
}

export function approvalPolicyHash(value: unknown): string { return policyHash(validatePolicy(value)); }

function emptyState(): ApprovalInboxState { return { schemaVersion: 1, requests: [], auditAnchor: sha256("ghostapi.approval.audit.v1"), audit: [] }; }
function validateState(value: unknown): ApprovalInboxState {
  const state = object(value, "Approval inbox store must be an object.");
  exactKeys(state, ["schemaVersion", "requests", "auditAnchor", "audit"], "Approval inbox store");
  if (state.schemaVersion !== 1) throw new ApprovalInboxError("Unsupported approval inbox schema version.");
  const requests = array(state.requests, "Approval requests", MAX_REQUESTS).map(validateRequest);
  unique(requests.map((request) => request.id), "Approval request ids");
  unique(requests.map((request) => request.actionHash), "Approval action hashes");
  const anchor = hash(state.auditAnchor, "Approval audit anchor");
  const audit = array(state.audit, "Approval audit", MAX_AUDIT).map(validateAudit);
  validateAuditChain(anchor, audit);
  return { schemaVersion: 1, requests, auditAnchor: anchor, audit };
}
function validateRequest(value: unknown): ApprovalRequest {
  const request = object(value, "Approval request is invalid.");
  exactKeys(request, ["id", "action", "actionHash", "risk", "context", "policy", "display", "status", "createdAt", "expiresAt", "escalationAt", "decisions", "artifact", "consumedAt", "executionReceiptHash", "supersedesRequestId"], "Approval request", ["artifact", "consumedAt", "executionReceiptHash", "supersedesRequestId"]);
  const action = validateActionEnvelope(request.action);
  const actionDigest = hash(request.actionHash, "Approval action hash");
  if (actionHash(action) !== actionDigest || classify(action) !== risk(request.risk)) throw new ApprovalInboxError("Approval request action is invalid.");
  const context = validateContext(request.context); const policy = policyRecord(request.policy); const displayValue = displayRecord(request.display, action, context);
  const decisions = array(request.decisions, "Approval decisions", MAX_DECISIONS).map(validateDecision);
  const createdAt = timestamp(request.createdAt, "Approval creation time");
  const expiresAt = timestamp(request.expiresAt, "Approval expiry");
  const escalationAt = timestamp(request.escalationAt, "Approval escalation time");
  if (!validStatus(request.status) || Date.parse(expiresAt) <= Date.parse(createdAt) || Date.parse(escalationAt) > Date.parse(expiresAt)) throw new ApprovalInboxError("Approval request lifecycle is invalid.");
  const artifact = request.artifact === undefined ? undefined : validateArtifact(request.artifact, actionDigest);
  if ((request.status === "approved" || request.status === "executing" || request.status === "executed" || request.status === "execution_failed") && artifact === undefined) throw new ApprovalInboxError("Approved requests require an approval artifact.");
  const consumedAt = request.consumedAt === undefined ? undefined : timestamp(request.consumedAt, "Approval consumption time");
  if ((request.status === "executing" || request.status === "executed" || request.status === "execution_failed") && consumedAt === undefined) throw new ApprovalInboxError("Executed approvals require consumption metadata.");
  const executionReceiptHash = request.executionReceiptHash === undefined ? undefined : hash(request.executionReceiptHash, "Approval execution receipt hash");
  if (request.status === "executed" && executionReceiptHash === undefined) throw new ApprovalInboxError("Executed approvals require an action receipt hash.");
  return { id: identifier(request.id, "Approval request id"), action, actionHash: actionDigest, risk: risk(request.risk), context, policy, display: displayValue, status: request.status, createdAt, expiresAt, escalationAt, decisions, ...(artifact === undefined ? {} : { artifact }), ...(consumedAt === undefined ? {} : { consumedAt }), ...(executionReceiptHash === undefined ? {} : { executionReceiptHash }), ...(request.supersedesRequestId === undefined ? {} : { supersedesRequestId: identifier(request.supersedesRequestId, "Superseded approval request id") }) };
}
function validateAudit(value: unknown): ApprovalAuditRecord {
  const record = object(value, "Approval audit record is invalid."); exactKeys(record, ["sequence", "event", "requestId", "actionHash", "actionReceiptHash", "actorId", "timestamp", "previousHash", "recordHash"], "Approval audit record", ["actionReceiptHash"]);
  const base = { sequence: positive(record.sequence, "Approval audit sequence"), event: text(record.event, "Approval audit event", 80), requestId: identifier(record.requestId, "Approval audit request id"), actionHash: hash(record.actionHash, "Approval audit action hash"), ...(record.actionReceiptHash === undefined ? {} : { actionReceiptHash: hash(record.actionReceiptHash, "Approval audit receipt hash") }), actorId: identifier(record.actorId, "Approval audit actor id"), timestamp: timestamp(record.timestamp, "Approval audit timestamp"), previousHash: hash(record.previousHash, "Approval audit previous hash") };
  if (hash(record.recordHash, "Approval audit record hash") !== sha256(canonical(base))) throw new ApprovalInboxError("Approval audit record hash is invalid.");
  return { ...base, recordHash: record.recordHash as string };
}
function validateAuditChain(anchor: string, audit: ApprovalAuditRecord[]): void { let previous = anchor; let sequence = 1; for (const record of audit) { if (record.sequence !== sequence || record.previousHash !== previous) throw new ApprovalInboxError("Approval audit chain is invalid."); previous = record.recordHash; sequence += 1; } }
function validatePolicy(value: unknown): ApprovalPolicy {
  const policy = object(value, "Approval policy is invalid."); exactKeys(policy, ["schemaVersion", "kind", "id", "version", "allowedEnvironments", "allowedActors", "allowedResources", "maxAmountMinor", "minimumConfidence", "criticalRisks", "velocity", "approvalTtlMs", "escalationTimeoutMs"], "Approval policy", ["allowedActors", "allowedResources", "maxAmountMinor"]);
  if (policy.schemaVersion !== 1 || policy.kind !== "ghostapi.approval-policy") throw new ApprovalInboxError("Unsupported approval policy schema.");
  const velocity = object(policy.velocity, "Approval velocity policy is invalid."); exactKeys(velocity, ["maxActions", "windowMs"], "Approval velocity policy");
  const result: ApprovalPolicy = { schemaVersion: 1, kind: "ghostapi.approval-policy", id: identifier(policy.id, "Approval policy id"), version: positive(policy.version, "Approval policy version"), allowedEnvironments: identifiers(policy.allowedEnvironments, "Approval allowed environments"), ...(policy.allowedActors === undefined ? {} : { allowedActors: identifiers(policy.allowedActors, "Approval allowed actors") }), ...(policy.allowedResources === undefined ? {} : { allowedResources: identifiers(policy.allowedResources, "Approval allowed resources") }), ...(policy.maxAmountMinor === undefined ? {} : { maxAmountMinor: nonNegative(policy.maxAmountMinor, "Approval max amount") }), minimumConfidence: percentage(policy.minimumConfidence, "Approval minimum confidence"), criticalRisks: risks(policy.criticalRisks), velocity: { maxActions: positive(velocity.maxActions, "Approval velocity maximum"), windowMs: boundedMs(velocity.windowMs, "Approval velocity window") }, approvalTtlMs: boundedMs(policy.approvalTtlMs, "Approval TTL"), escalationTimeoutMs: boundedMs(policy.escalationTimeoutMs, "Approval escalation timeout") };
  if (result.escalationTimeoutMs > result.approvalTtlMs) throw new ApprovalInboxError("Approval escalation timeout cannot exceed approval TTL.");
  return result;
}
function evaluate(policy: ApprovalPolicy, action: ActionEnvelope, context: ApprovalContext, history: ApprovalRequest[], now: string, currentId?: string): { allowed: boolean; requiredApprovals: number; reasons: string[] } {
  const reasons: string[] = []; const actionRisk = classify(action);
  if (!policy.allowedEnvironments.includes(action.project.environment)) reasons.push("environment is not approved");
  if (policy.allowedActors !== undefined && !policy.allowedActors.includes(action.actor.id)) reasons.push("actor is not approved");
  if (policy.allowedResources !== undefined && !policy.allowedResources.includes(action.resource.id)) reasons.push("resource is not approved");
  if (policy.maxAmountMinor !== undefined && (context.amountMinor === undefined || context.amountMinor > policy.maxAmountMinor)) reasons.push("amount is missing or exceeds the policy limit");
  const cutoff = Date.parse(now) - policy.velocity.windowMs;
  if (history.filter((request) => request.id !== currentId && request.action.actor.id === action.actor.id && Date.parse(request.createdAt) >= cutoff && request.status !== "superseded").length >= policy.velocity.maxActions) reasons.push("action velocity limit was reached");
  const requiredApprovals = policy.criticalRisks.includes(actionRisk) || context.confidence < policy.minimumConfidence ? 2 : 1;
  reasons.push(requiredApprovals === 2 ? "independent two-person approval is required" : "independent human approval is required");
  return { allowed: reasons.length === 1, requiredApprovals, reasons };
}
function display(action: ActionEnvelope, context: ApprovalContext, policyReason: string[]): ApprovalDisplay { return { intent: "Update a local synthetic subscription failure workflow.", target: `${action.resource.type}/${action.resource.id}`, normalizedArgumentDiff: { before: {}, after: clone(action.arguments) }, expectedSideEffects: [...action.expectedSideEffects], reversibility: action.reversibility, impact: { amountMinor: context.amountMinor ?? null, amountKnown: context.amountMinor !== undefined, irreversible: action.reversibility === "none" }, policyReason, evidenceHash: action.evidence.hash, simulation: { status: "passed", summary: "Synthetic adapter preflight found the local target world." } }; }
function displayRecord(value: unknown, action: ActionEnvelope, context: ApprovalContext): ApprovalDisplay { const candidate = object(value, "Approval display is invalid."); exactKeys(candidate, ["intent", "target", "normalizedArgumentDiff", "expectedSideEffects", "reversibility", "impact", "policyReason", "evidenceHash", "simulation"], "Approval display"); const generated = display(action, context, array(candidate.policyReason, "Approval policy reason", 16).map((item) => text(item, "Approval policy reason", 200))); if (canonical(candidate) !== canonical(generated)) throw new ApprovalInboxError("Approval display does not match normalized action data."); return generated; }
function createArtifact(request: ApprovalRequest, now: string): ActionApproval { return { schemaVersion: 1, kind: "ghostapi.action-approval", approvalId: request.id, actionHash: request.actionHash, approvedBy: "approval-inbox", approvedAt: now, expiresAt: request.expiresAt, nonce: `inbox-${request.actionHash.slice(0, 32)}` }; }
function validateArtifact(value: unknown, actionDigest: string): ActionApproval { const artifact = object(value, "Approval artifact is invalid."); exactKeys(artifact, ["schemaVersion", "kind", "approvalId", "actionHash", "approvedBy", "approvedAt", "expiresAt", "nonce"], "Approval artifact"); if (artifact.schemaVersion !== 1 || artifact.kind !== "ghostapi.action-approval" || artifact.actionHash !== actionDigest || artifact.approvedBy !== "approval-inbox") throw new ApprovalInboxError("Approval artifact is invalid."); return { schemaVersion: 1, kind: "ghostapi.action-approval", approvalId: identifier(artifact.approvalId, "Approval artifact id"), actionHash: actionDigest, approvedBy: "approval-inbox", approvedAt: timestamp(artifact.approvedAt, "Approval artifact issue time"), expiresAt: timestamp(artifact.expiresAt, "Approval artifact expiry"), nonce: identifier(artifact.nonce, "Approval artifact nonce") }; }
function policyRecord(value: unknown): ApprovalRequest["policy"] { const policy = object(value, "Approval policy record is invalid."); exactKeys(policy, ["id", "version", "hash", "requiredApprovals"], "Approval policy record"); const requiredApprovals = policy.requiredApprovals; if (requiredApprovals !== 1 && requiredApprovals !== 2) throw new ApprovalInboxError("Approval requirement is invalid."); return { id: identifier(policy.id, "Approval policy id"), version: positive(policy.version, "Approval policy version"), hash: hash(policy.hash, "Approval policy hash"), requiredApprovals }; }
function validateContext(value: unknown): ApprovalContext { const context = object(value, "Approval context is invalid."); exactKeys(context, ["confidence", "amountMinor"], "Approval context", ["amountMinor"]); return { confidence: percentage(context.confidence, "Approval confidence"), ...(context.amountMinor === undefined ? {} : { amountMinor: nonNegative(context.amountMinor, "Approval amount") }) }; }
function validateApprover(value: unknown): ApprovalApprover { const approver = object(value, "Approver identity is invalid."); exactKeys(approver, ["id", "independenceKey"], "Approver identity"); return { id: identifier(approver.id, "Approver id"), independenceKey: identifier(approver.independenceKey, "Approver independence key") }; }
function validateDecision(value: unknown): ApprovalDecision { const decision = object(value, "Approval decision is invalid."); exactKeys(decision, ["id", "kind", "approverId", "independenceKey", "reason", "decidedAt"], "Approval decision", ["reason"]); if (decision.kind !== "approve" && decision.kind !== "reject" && decision.kind !== "revoke") throw new ApprovalInboxError("Approval decision kind is invalid."); return { id: identifier(decision.id, "Approval decision id"), kind: decision.kind, approverId: identifier(decision.approverId, "Approver id"), independenceKey: identifier(decision.independenceKey, "Approver independence key"), ...(decision.reason === undefined ? {} : { reason: text(decision.reason, "Approval decision reason", 200) }), decidedAt: timestamp(decision.decidedAt, "Approval decision time") }; }
function appendAudit(state: ApprovalInboxState, event: string, request: ApprovalRequest, actorId: string, timestampValue: string, actionReceiptHash?: string): void { const previous = state.audit.at(-1)?.recordHash ?? state.auditAnchor; const base = { sequence: state.audit.length + 1, event, requestId: request.id, actionHash: request.actionHash, ...(actionReceiptHash === undefined ? {} : { actionReceiptHash }), actorId: identifier(actorId, "Approval audit actor id"), timestamp: timestampValue, previousHash: previous }; state.audit.push({ ...base, recordHash: sha256(canonical(base)) }); }
function refresh(state: ApprovalInboxState, now: string): void { for (const request of state.requests) { if (request.status === "pending" && Date.parse(now) >= Date.parse(request.escalationAt)) { request.status = "timed_out"; appendAudit(state, "request.timed_out", request, "approval-inbox", now); } else if ((request.status === "pending" || request.status === "approved") && Date.parse(now) >= Date.parse(request.expiresAt)) { request.status = "expired"; appendAudit(state, "request.expired", request, "approval-inbox", now); } } }
function classify(action: ActionEnvelope): ApprovalRisk { if (action.provider === "ghostapi-synthetic" && action.operation === "synthetic.subscription_failure") return "update"; throw new ApprovalInboxError("No approval risk taxonomy rule exists for this action."); }
function risk(value: unknown): ApprovalRisk { if (value !== "read" && value !== "create" && value !== "update" && value !== "communicate" && value !== "money_movement" && value !== "delete" && value !== "permission_change" && value !== "deployment") throw new ApprovalInboxError("Approval risk is invalid."); return value; }
function risks(value: unknown): ApprovalRisk[] { const parsed = array(value, "Approval critical risks", 8).map(risk); unique(parsed, "Approval critical risks"); return parsed.sort(); }
function requirePending(request: ApprovalRequest): void { if (request.status !== "pending") throw new ApprovalInboxError("Approval is not pending."); }
function assertIndependent(request: ApprovalRequest, approver: ApprovalApprover): void { if (approver.id === request.action.actor.id || approver.id === request.action.actor.workloadId || approver.independenceKey === request.action.actor.id || approver.independenceKey === request.action.actor.workloadId) throw new ApprovalInboxError("Action workload cannot approve its own action."); }
function findRequest(state: ApprovalInboxState, requestId: string): ApprovalRequest { const request = state.requests.find((candidate) => candidate.id === requestId); if (request === undefined) throw new ApprovalInboxError("Approval request was not found."); return request; }
function validStatus(value: unknown): value is ApprovalRequestStatus { return value === "pending" || value === "approved" || value === "rejected" || value === "revoked" || value === "timed_out" || value === "expired" || value === "executing" || value === "executed" || value === "execution_failed" || value === "superseded"; }
function policyHash(policy: ApprovalPolicy): string { return sha256(canonical(policy)); }
function canonical(value: unknown): string { if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; throw new ApprovalInboxError("Approval data must be JSON."); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || !IDENTIFIER.test(value) || sanitizeSecretString(value) !== value) throw new ApprovalInboxError(`${label} must be a safe identifier.`); return value; }
function hash(value: unknown, label: string): string { if (typeof value !== "string" || !HASH.test(value)) throw new ApprovalInboxError(`${label} must be a SHA-256 hash.`); return value; }
function timestamp(value: unknown, label: string): string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ApprovalInboxError(`${label} must be an ISO UTC timestamp.`); return value; }
function positive(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100_000) throw new ApprovalInboxError(`${label} is invalid.`); return value; }
function nonNegative(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new ApprovalInboxError(`${label} is invalid.`); return value; }
function percentage(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) throw new ApprovalInboxError(`${label} must be an integer from 0 to 100.`); return value; }
function boundedMs(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1_000 || value > 24 * 60 * 60 * 1000) throw new ApprovalInboxError(`${label} is invalid.`); return value; }
function text(value: unknown, label: string, max: number): string { if (typeof value !== "string" || value.trim() === "" || value.length > max || /[\u0000-\u001f]/.test(value) || sanitizeSecretString(value) !== value) throw new ApprovalInboxError(`${label} is invalid.`); return value.trim(); }
function identifiers(value: unknown, label: string): string[] { const result = array(value, label, 100).map((entry) => identifier(entry, label)); if (result.length === 0) throw new ApprovalInboxError(`${label} must not be empty.`); unique(result, label); return result.sort(); }
function object(value: unknown, message: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ApprovalInboxError(message); return value as Record<string, unknown>; }
function array(value: unknown, label: string, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new ApprovalInboxError(`${label} is invalid.`); return value; }
function exactKeys(value: Record<string, unknown>, keys: string[], label: string, optional: string[] = []): void { for (const key of Object.keys(value)) if (!keys.includes(key) || (value[key] === undefined && !optional.includes(key))) throw new ApprovalInboxError(`${label} contains unsupported field: ${key}`); }
function unique(values: string[], label: string): void { if (new Set(values).size !== values.length) throw new ApprovalInboxError(`${label} must be unique.`); }
function clone<T>(value: T): T { return structuredClone(value); }
function isErrorCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
