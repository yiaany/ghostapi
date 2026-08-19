import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { type ActionApproval, type ActionEnvelope, type ActionExecutionReceipt, actionApprovalHash, actionHash, validateStoredAction } from "../actions/index.js";
import { createScenarioReplayer, prepareScenarioRecording, validateScenarioBundle, type ScenarioBundle, type ScenarioReplayRequest, writeScenarioBundle } from "../scenarios/scenarioBundle.js";
import { sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";
import { createWorld, inspectWorld, SyntheticWorldError } from "../worlds/index.js";

const LEDGER_SCHEMA_VERSION = 1;
const LEDGER_KIND = "ghostapi.action-ledger";
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 2_000;
const MAX_TENANTS = 200;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

export type LedgerPermission = "append" | "read" | "export" | "manage_retention" | "manage_hold" | "request_deletion";
export type LedgerStage = "intent" | "identity" | "policy_decision" | "approval" | "credential_grant" | "execution_attempt" | "provider_receipt" | "verification" | "compensation" | "retention" | "legal_hold" | "deletion_request";

export type LedgerAccess = {
  tenantId: string;
  principalId: string;
  permissions: readonly LedgerPermission[];
};

export type LedgerAccessAuthorizer = (access: unknown, permission: LedgerPermission, tenantId: string) => LedgerAccess;

export type LedgerEntry = {
  schemaVersion: 1;
  kind: "ghostapi.action-ledger-entry";
  tenantId: string;
  sequence: number;
  timestamp: string;
  actionId: string;
  actionHash: string;
  stage: LedgerStage;
  data: Record<string, string | number | boolean | null>;
  previousHash: string;
  entryHash: string;
};

export type LedgerTenantState = {
  tenantId: string;
  entryCount: number;
  headHash: string;
  retentionDays: number | null;
  legalHold: boolean;
  deletionRequestedAt?: string;
};

export type ActionLedgerState = {
  schemaVersion: 1;
  kind: "ghostapi.action-ledger";
  entries: LedgerEntry[];
  tenants: LedgerTenantState[];
};

export type ActionLedgerRecord = {
  envelope: ActionEnvelope;
  approval: ActionApproval;
  receipts: readonly ActionExecutionReceipt[];
  credentialGrant?: { grantIdHash: string; credentialVersion: number };
};

export type LedgerVerification = { valid: true; entryCount: number; headHash: string; tracked: boolean } | { valid: false; error: string };

export type LedgerExport = {
  schemaVersion: 1;
  kind: "ghostapi.action-ledger-export";
  tenantId: string;
  exportedAt: string;
  integrity: LedgerVerification;
  entries: LedgerEntry[];
};

export type IncidentFixture = {
  schemaVersion: 1;
  kind: "ghostapi.incident-fixture";
  tenantId: string;
  actionId: string;
  actionHash: string;
  sourceLedgerHeadHash: string;
  syntheticWorld: { id: string; version: "1.0.0"; seed: string };
  bundle: ScenarioBundle;
  request: ScenarioReplayRequest;
  expected: { status: number; outcome: "verified" | "requires_reconciliation" };
};

export type IncidentReplayResult = { status: number; outcome: "verified" | "requires_reconciliation"; remaining: number };

export type ActionLedgerOptions = {
  path?: string;
  incidentsPath?: string;
  now?: () => Date;
  accessAuthorizer?: LedgerAccessAuthorizer;
};

export class ActionLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionLedgerError";
  }
}

export class LocalActionLedger {
  private readonly path: string;
  private readonly incidentsPath: string;
  private readonly now: () => Date;
  private readonly accessAuthorizer: LedgerAccessAuthorizer;

  constructor(options: ActionLedgerOptions = {}) {
    this.path = options.path ?? getDataPaths().actionLedger;
    this.incidentsPath = options.incidentsPath ?? getDataPaths().incidents;
    this.now = options.now ?? (() => new Date());
    this.accessAuthorizer = options.accessAuthorizer ?? denyLedgerAccess;
  }

  async recordAction(accessValue: unknown, recordValue: ActionLedgerRecord): Promise<LedgerEntry[]> {
    const access = this.authorize(accessValue, "append");
    const record = normalizeActionRecord(recordValue);
    return this.mutate(async (state) => {
      const existing = entriesForAction(state, access.tenantId, record.envelope.actionId);
      if (existing.length > 0) {
        if (existing[0]!.actionHash !== actionHash(record.envelope)) throw new ActionLedgerError("Action id already has a different ledger timeline in this tenant.");
        return { state, result: existing };
      }
      const entries: LedgerEntry[] = [];
      const append = (stage: LedgerStage, data: LedgerEntry["data"]) => {
        const entry = appendEntry(state, access.tenantId, record.envelope.actionId, actionHash(record.envelope), stage, data, this.now().toISOString());
        entries.push(entry);
      };
      append("intent", {
        operation: record.envelope.operation,
        resourceType: record.envelope.resource.type,
        resourceIdHash: sha256(record.envelope.resource.id),
        argumentsHash: sha256(canonicalJson(record.envelope.arguments)),
        expectedEffectsHash: sha256(canonicalJson(record.envelope.expectedSideEffects)),
        riskClass: record.envelope.riskClass,
        reversibility: record.envelope.reversibility
      });
      append("identity", { actorId: record.envelope.actor.id, workloadId: record.envelope.actor.workloadId, actorType: record.envelope.actor.type });
      append("policy_decision", { policyVersion: record.envelope.policy.version, policyHash: record.envelope.policy.hash, allowed: true, basis: "caller_claimed" });
      append("approval", { approvalHash: actionApprovalHash(record.approval), approverId: record.approval.approvedBy, status: "approved", basis: "caller_claimed" });
      append("credential_grant", record.credentialGrant === undefined
        ? { status: "not_used" }
        : { status: "granted", grantIdHash: hash(record.credentialGrant.grantIdHash, "Credential grant reference"), credentialVersion: positiveInteger(record.credentialGrant.credentialVersion, "Credential version") });
      for (const receipt of record.receipts) appendReceiptEvidence(append, receipt);
      append("compensation", { status: record.envelope.reversibility === "compensatable" ? "not_attempted" : "not_supported" });
      return { state, result: entries };
    });
  }

  async timeline(accessValue: unknown, actionIdValue: string): Promise<LedgerEntry[]> {
    const access = this.authorize(accessValue, "read");
    const actionId = identifier(actionIdValue, "Action id");
    const state = await this.readState();
    assertTenantIntegrity(state, access.tenantId);
    return entriesForAction(state, access.tenantId, actionId);
  }

  async exportTenant(accessValue: unknown): Promise<LedgerExport> {
    const access = this.authorize(accessValue, "export");
    const state = await this.readState();
    const integrity = verifyTenantState(state, access.tenantId);
    if (!integrity.valid) throw new ActionLedgerError(`Ledger integrity verification failed: ${integrity.error}`);
    return {
      schemaVersion: 1,
      kind: "ghostapi.action-ledger-export",
      tenantId: access.tenantId,
      exportedAt: this.now().toISOString(),
      integrity,
      entries: state.entries.filter((entry) => entry.tenantId === access.tenantId).map((entry) => structuredClone(entry))
    };
  }

  async verifyTenant(accessValue: unknown): Promise<LedgerVerification> {
    const access = this.authorize(accessValue, "read");
    try {
      return verifyTenantState(await this.readState(), access.tenantId);
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : "Ledger state could not be validated." };
    }
  }

  async configureRetention(accessValue: unknown, retentionDaysValue: number | null): Promise<LedgerTenantState> {
    const access = this.authorize(accessValue, "manage_retention");
    const retentionDays = retentionDaysValue === null ? null : boundedInteger(retentionDaysValue, "Retention days", 1, 3_650);
    return this.mutate(async (state) => {
      const tenant = getOrCreateTenant(state, access.tenantId);
      tenant.retentionDays = retentionDays;
      appendEntry(state, access.tenantId, governanceActionId("retention", state, access.tenantId), sha256(`retention:${access.tenantId}`), "retention", { retentionDays }, this.now().toISOString());
      return { state, result: structuredClone(tenant) };
    });
  }

  async setLegalHold(accessValue: unknown, active: boolean): Promise<LedgerTenantState> {
    const access = this.authorize(accessValue, "manage_hold");
    if (typeof active !== "boolean") throw new ActionLedgerError("Legal hold state must be boolean.");
    return this.mutate(async (state) => {
      const tenant = getOrCreateTenant(state, access.tenantId);
      tenant.legalHold = active;
      appendEntry(state, access.tenantId, governanceActionId("hold", state, access.tenantId), sha256(`legal-hold:${access.tenantId}`), "legal_hold", { active }, this.now().toISOString());
      return { state, result: structuredClone(tenant) };
    });
  }

  async requestDeletion(accessValue: unknown): Promise<LedgerTenantState> {
    const access = this.authorize(accessValue, "request_deletion");
    return this.mutate(async (state) => {
      const tenant = getOrCreateTenant(state, access.tenantId);
      if (tenant.legalHold) throw new ActionLedgerError("Deletion request is blocked by the active local legal hold.");
      if (tenant.deletionRequestedAt === undefined) {
        tenant.deletionRequestedAt = this.now().toISOString();
        appendEntry(state, access.tenantId, governanceActionId("deletion", state, access.tenantId), sha256(`deletion:${access.tenantId}`), "deletion_request", { status: "requested" }, tenant.deletionRequestedAt);
      }
      return { state, result: structuredClone(tenant) };
    });
  }

  async createIncidentFixture(accessValue: unknown, actionIdValue: string): Promise<{ fixture: IncidentFixture; bundlePath: string; fixturePath: string }> {
    const access = this.authorize(accessValue, "read");
    const actionId = identifier(actionIdValue, "Action id");
    const state = await this.readState();
    const integrity = verifyTenantState(state, access.tenantId);
    if (!integrity.valid) throw new ActionLedgerError(`Ledger integrity verification failed: ${integrity.error}`);
    const timeline = entriesForAction(state, access.tenantId, actionId);
    const intent = timeline.find((entry) => entry.stage === "intent");
    if (intent === undefined) throw new ActionLedgerError("Incident replay requires an action intent in the tenant-scoped ledger timeline.");
    const verification = timeline.filter((entry) => entry.stage === "verification").at(-1);
    const outcome = verification?.data.status === "verified" ? "verified" : "requires_reconciliation";
    const actionDigest = intent.actionHash;
    const runId = deterministicUuid(actionDigest);
    const capture = {
      interactions: [{
        request: { method: "POST", url: `https://incident.sandbox.localhost/incidents/${actionId}/runs/${runId}`, headers: { "content-type": "application/json" }, body: { action: actionId, actionHash: actionDigest } },
        response: { status: outcome === "verified" ? 200 : 409, headers: { "content-type": "application/json" }, body: { outcome, action: actionId } }
      }]
    };
    const bundle = prepareScenarioRecording(capture, { title: `Incident ${actionId}`, allowedSandboxHosts: ["incident.sandbox.localhost"], recordedAt: this.now().toISOString() });
    const worldId = `incident-${actionDigest.slice(0, 16)}`;
    const seed = `incident-${actionDigest.slice(0, 32)}`;
    try {
      const world = await inspectWorld(worldId);
      if (world.manifest.seed !== seed) throw new ActionLedgerError("Incident synthetic world id collides with a different deterministic seed.");
    } catch (error) {
      if (error instanceof SyntheticWorldError && error.code === "WORLD_NOT_FOUND") await createWorld({ id: worldId, seed, title: `Incident replay ${actionId}` });
      else if (error instanceof ActionLedgerError) throw error;
      else throw error;
    }
    const request: ScenarioReplayRequest = { method: "POST", path: `/incidents/${actionId}/runs/${runId}`, headers: { "content-type": "application/json" }, body: { action: actionId, actionHash: actionDigest } };
    const fixture: IncidentFixture = {
      schemaVersion: 1,
      kind: "ghostapi.incident-fixture",
      tenantId: access.tenantId,
      actionId,
      actionHash: actionDigest,
      sourceLedgerHeadHash: integrity.headHash,
      syntheticWorld: { id: worldId, version: "1.0.0", seed },
      bundle,
      request,
      expected: { status: outcome === "verified" ? 200 : 409, outcome }
    };
    await ensurePrivateDirectory(this.incidentsPath);
    const prefix = `incident-${actionDigest.slice(0, 16)}`;
    const bundlePath = await writeScenarioBundle(bundle, join(this.incidentsPath, `${prefix}.bundle.json`), getDataPaths().root);
    const fixturePath = join(this.incidentsPath, `${prefix}.fixture.json`);
    await atomicWriteJson(fixturePath, validateIncidentFixture(fixture));
    return { fixture, bundlePath, fixturePath };
  }

  async replayIncidentFixture(accessValue: unknown, fixtureValue: unknown): Promise<IncidentReplayResult> {
    const access = this.authorize(accessValue, "read");
    const fixture = validateIncidentFixture(fixtureValue);
    if (fixture.tenantId !== access.tenantId) throw new ActionLedgerError("Incident fixture belongs to a different tenant.");
    const replay = createScenarioReplayer(fixture.bundle);
    const result = replay.replay(fixture.request);
    const outcome = readOutcome(result.body);
    if (result.status !== fixture.expected.status || outcome !== fixture.expected.outcome || replay.remaining !== 0) throw new ActionLedgerError("Incident fixture did not reproduce its expected local outcome.");
    return { status: result.status, outcome, remaining: replay.remaining };
  }

  private authorize(access: unknown, permission: LedgerPermission): LedgerAccess {
    const authorized = this.accessAuthorizer(access, permission, accessTenantId(access));
    if (!authorized.permissions.includes(permission)) throw new ActionLedgerError("Ledger access authorizer returned an insufficient permission set.");
    return { tenantId: identifier(authorized.tenantId, "Ledger tenant id"), principalId: identifier(authorized.principalId, "Ledger principal id"), permissions: [...authorized.permissions] };
  }

  private async readState(): Promise<ActionLedgerState> {
    await ensurePrivateDirectory(getDataPaths().root);
    const info = await lstat(this.path).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
    if (info === null) return emptyState();
    if (!info.isFile() || info.isSymbolicLink()) throw new ActionLedgerError("Action ledger must be a regular non-symlink file.");
    const source = await readFile(this.path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_LEDGER_BYTES) throw new ActionLedgerError(`Action ledger exceeds ${MAX_LEDGER_BYTES} bytes.`);
    try {
      return validateState(JSON.parse(source));
    } catch (error) {
      if (error instanceof ActionLedgerError) throw error;
      throw new ActionLedgerError("Action ledger is not valid JSON.");
    }
  }

  private async mutate<T>(operation: (state: ActionLedgerState) => Promise<{ state: ActionLedgerState; result: T }>): Promise<T> {
    return withFileLock(this.path, async () => {
      const state = await this.readState();
      const { state: next, result } = await operation(state);
      validateState(next);
      await atomicWriteJson(this.path, next);
      return result;
    });
  }
}

export function createLocalActionLedger(options: ActionLedgerOptions = {}): LocalActionLedger {
  return new LocalActionLedger(options);
}

export function createTestLedgerAccessAuthorizer(): { authorizer: LedgerAccessAuthorizer; issue(input: LedgerAccess): object } {
  const granted = new WeakMap<object, LedgerAccess>();
  return {
    issue(input) {
      const access = { tenantId: identifier(input.tenantId, "Ledger tenant id"), principalId: identifier(input.principalId, "Ledger principal id"), permissions: normalizePermissions(input.permissions) };
      const capability = Object.freeze({ tenantId: access.tenantId });
      granted.set(capability, access);
      return capability;
    },
    authorizer(access, permission, tenantId) {
      if (access === null || typeof access !== "object") throw new ActionLedgerError("Ledger access is not a verified capability.");
      const grantedAccess = granted.get(access);
      if (grantedAccess === undefined || grantedAccess.tenantId !== tenantId || !grantedAccess.permissions.includes(permission)) throw new ActionLedgerError("Ledger access is unauthorized.");
      return grantedAccess;
    }
  };
}

export function validateIncidentFixture(value: unknown): IncidentFixture {
  const fixture = object(value, "Incident fixture must be an object.");
  exactKeys(fixture, ["schemaVersion", "kind", "tenantId", "actionId", "actionHash", "sourceLedgerHeadHash", "syntheticWorld", "bundle", "request", "expected"], "Incident fixture");
  if (fixture.schemaVersion !== 1 || fixture.kind !== "ghostapi.incident-fixture") throw new ActionLedgerError("Unsupported incident fixture schema.");
  const world = object(fixture.syntheticWorld, "Incident fixture world is invalid.");
  exactKeys(world, ["id", "version", "seed"], "Incident fixture world");
  if (world.version !== "1.0.0") throw new ActionLedgerError("Incident fixture world version is invalid.");
  const expected = object(fixture.expected, "Incident fixture expected outcome is invalid.");
  exactKeys(expected, ["status", "outcome"], "Incident fixture expected outcome");
  if ((expected.status !== 200 && expected.status !== 409) || (expected.outcome !== "verified" && expected.outcome !== "requires_reconciliation")) throw new ActionLedgerError("Incident fixture expected outcome is invalid.");
  const request = object(fixture.request, "Incident fixture request is invalid.");
  return {
    schemaVersion: 1,
    kind: "ghostapi.incident-fixture",
    tenantId: identifier(fixture.tenantId, "Incident fixture tenant id"),
    actionId: identifier(fixture.actionId, "Incident fixture action id"),
    actionHash: hash(fixture.actionHash, "Incident fixture action hash"),
    sourceLedgerHeadHash: hash(fixture.sourceLedgerHeadHash, "Incident fixture ledger head hash"),
    syntheticWorld: { id: identifier(world.id, "Incident fixture world id"), version: "1.0.0", seed: safeString(world.seed, "Incident fixture world seed", 64) },
    bundle: prepareBundle(fixture.bundle),
    request: { method: safeString(request.method, "Incident fixture request method", 10), path: safeString(request.path, "Incident fixture request path", 8_000), headers: normalizeFixtureHeaders(request.headers), body: sanitizeStructured(request.body, "Incident fixture request body") },
    expected: { status: expected.status, outcome: expected.outcome }
  };
}

function prepareBundle(value: unknown): ScenarioBundle {
  // The scenario module performs strict data-only validation; no replay transport is created here.
  const bundle = validateScenarioBundle(value);
  if (bundle.interactions.length !== 1 || bundle.metadata.sandboxHosts.length !== 1 || bundle.metadata.sandboxHosts[0] !== "incident.sandbox.localhost") throw new ActionLedgerError("Incident fixture must contain one local-only replay interaction.");
  return bundle;
}

function appendReceiptEvidence(append: (stage: LedgerStage, data: LedgerEntry["data"]) => void, receipt: ActionExecutionReceipt): void {
  const status = safeString(receipt.status, "Action receipt status", 32);
  if (status === "attempted") append("execution_attempt", { attempt: 1, status: "attempted", receiptHash: hash(receipt.receiptHash, "Action receipt hash") });
  if (status === "committed") append("provider_receipt", { outcome: "committed", receiptHash: hash(receipt.receiptHash, "Action receipt hash"), providerReceiptHash: receipt.providerRequestId === undefined ? null : sha256(receipt.providerRequestId) });
  if (status === "verified") append("verification", { status: "verified", receiptHash: hash(receipt.receiptHash, "Action receipt hash"), proofHash: sha256(canonicalJson(receipt.result ?? null)) });
  if (status === "failed") {
    const ambiguous = receipt.failure?.code === "unknown_outcome";
    append("execution_attempt", { attempt: 1, status: ambiguous ? "ambiguous" : "failed", receiptHash: hash(receipt.receiptHash, "Action receipt hash") });
    append("verification", { status: ambiguous ? "ambiguous" : "failed", receiptHash: hash(receipt.receiptHash, "Action receipt hash"), proofHash: null });
  }
}

function normalizeActionRecord(value: ActionLedgerRecord): ActionLedgerRecord {
  const stored = validateStoredAction({ schemaVersion: 1, kind: "ghostapi.action-record", envelope: value.envelope, actionHash: actionHash(value.envelope), approval: value.approval, receipts: value.receipts });
  return { envelope: stored.envelope, approval: stored.approval, receipts: stored.receipts, ...(value.credentialGrant === undefined ? {} : { credentialGrant: value.credentialGrant }) };
}

function emptyState(): ActionLedgerState {
  return { schemaVersion: 1, kind: "ghostapi.action-ledger", entries: [], tenants: [] };
}

function validateState(value: unknown): ActionLedgerState {
  const state = object(value, "Action ledger state must be an object.");
  exactKeys(state, ["schemaVersion", "kind", "entries", "tenants"], "Action ledger state");
  if (state.schemaVersion !== LEDGER_SCHEMA_VERSION || state.kind !== LEDGER_KIND) throw new ActionLedgerError("Unsupported action ledger schema.");
  if (!Array.isArray(state.entries) || state.entries.length > MAX_ENTRIES || !Array.isArray(state.tenants) || state.tenants.length > MAX_TENANTS) throw new ActionLedgerError("Action ledger state exceeds its bounded limits.");
  const entries = state.entries.map(validateEntry);
  const tenants = state.tenants.map(validateTenant);
  if (new Set(tenants.map((tenant) => tenant.tenantId)).size !== tenants.length) throw new ActionLedgerError("Action ledger tenant state is duplicated.");
  for (const tenant of tenants) assertTenantIntegrity({ schemaVersion: 1, kind: "ghostapi.action-ledger", entries, tenants }, tenant.tenantId);
  if (new Set(entries.map((entry) => entry.tenantId)).size !== tenants.length && entries.some((entry) => !tenants.some((tenant) => tenant.tenantId === entry.tenantId))) throw new ActionLedgerError("Action ledger entry has no tenant state.");
  return { schemaVersion: 1, kind: "ghostapi.action-ledger", entries, tenants };
}

function validateEntry(value: unknown): LedgerEntry {
  const entry = object(value, "Ledger entry must be an object.");
  exactKeys(entry, ["schemaVersion", "kind", "tenantId", "sequence", "timestamp", "actionId", "actionHash", "stage", "data", "previousHash", "entryHash"], "Ledger entry");
  if (entry.schemaVersion !== 1 || entry.kind !== "ghostapi.action-ledger-entry" || !isStage(entry.stage)) throw new ActionLedgerError("Ledger entry schema is invalid.");
  const normalized: Omit<LedgerEntry, "entryHash"> = {
    schemaVersion: 1,
    kind: "ghostapi.action-ledger-entry",
    tenantId: identifier(entry.tenantId, "Ledger tenant id"),
    sequence: positiveInteger(entry.sequence, "Ledger sequence"),
    timestamp: timestamp(entry.timestamp, "Ledger timestamp"),
    actionId: identifier(entry.actionId, "Ledger action id"),
    actionHash: hash(entry.actionHash, "Ledger action hash"),
    stage: entry.stage,
    data: normalizeData(entry.data),
    previousHash: hash(entry.previousHash, "Ledger previous hash")
  };
  const entryHash = hash(entry.entryHash, "Ledger entry hash");
  if (entryHash !== sha256(canonicalJson(normalized))) throw new ActionLedgerError("Ledger entry hash is invalid.");
  return { ...normalized, entryHash };
}

function validateTenant(value: unknown): LedgerTenantState {
  const tenant = object(value, "Ledger tenant state is invalid.");
  exactKeys(tenant, ["tenantId", "entryCount", "headHash", "retentionDays", "legalHold", "deletionRequestedAt"], "Ledger tenant state");
  const deletionRequestedAt = tenant.deletionRequestedAt === undefined ? undefined : timestamp(tenant.deletionRequestedAt, "Ledger deletion request timestamp");
  if (tenant.retentionDays !== null && (!Number.isInteger(tenant.retentionDays) || typeof tenant.retentionDays !== "number" || tenant.retentionDays < 1 || tenant.retentionDays > 3_650) || typeof tenant.legalHold !== "boolean") throw new ActionLedgerError("Ledger tenant retention state is invalid.");
  return { tenantId: identifier(tenant.tenantId, "Ledger tenant id"), entryCount: nonNegativeInteger(tenant.entryCount, "Ledger tenant entry count"), headHash: hash(tenant.headHash, "Ledger tenant head hash"), retentionDays: tenant.retentionDays as number | null, legalHold: tenant.legalHold, ...(deletionRequestedAt === undefined ? {} : { deletionRequestedAt }) };
}

function appendEntry(state: ActionLedgerState, tenantId: string, actionId: string, actionDigest: string, stage: LedgerStage, data: LedgerEntry["data"], timestampValue: string): LedgerEntry {
  const tenant = getOrCreateTenant(state, tenantId);
  if (state.entries.length >= MAX_ENTRIES) {
    rotateForRetention(state, timestampValue);
    if (state.entries.length >= MAX_ENTRIES) throw new ActionLedgerError(`Action ledger entry limit of ${MAX_ENTRIES} was reached; export and controlled retention review are required.`);
  }
  const entry: Omit<LedgerEntry, "entryHash"> = {
    schemaVersion: 1,
    kind: "ghostapi.action-ledger-entry",
    tenantId,
    sequence: tenant.entryCount + 1,
    timestamp: timestamp(timestampValue, "Ledger timestamp"),
    actionId: identifier(actionId, "Ledger action id"),
    actionHash: hash(actionDigest, "Ledger action hash"),
    stage,
    data: normalizeData(data),
    previousHash: tenant.entryCount === 0 ? genesisHash(tenantId) : tenant.headHash
  };
  const appended = { ...entry, entryHash: sha256(canonicalJson(entry)) };
  state.entries.push(appended);
  tenant.entryCount = appended.sequence;
  tenant.headHash = appended.entryHash;
  return appended;
}

function rotateForRetention(state: ActionLedgerState, now: string): void {
  for (const tenant of state.tenants) {
    if (tenant.retentionDays === null || tenant.legalHold) continue;
    const cutoff = Date.parse(now) - tenant.retentionDays * 86_400_000;
    const surviving = state.entries
      .filter((entry) => entry.tenantId === tenant.tenantId)
      .sort((left, right) => left.sequence - right.sequence)
      .filter((entry) => Date.parse(entry.timestamp) >= cutoff);
    if (surviving.length === state.entries.filter((entry) => entry.tenantId === tenant.tenantId).length) continue;
    const rebuilt = relinkTenantChain(tenant.tenantId, surviving);
    state.entries = state.entries.filter((entry) => entry.tenantId !== tenant.tenantId).concat(rebuilt);
    tenant.entryCount = rebuilt.length;
    tenant.headHash = rebuilt.at(-1)?.entryHash ?? genesisHash(tenant.tenantId);
  }
}

function relinkTenantChain(tenantId: string, surviving: LedgerEntry[]): LedgerEntry[] {
  let previousHash = genesisHash(tenantId);
  return surviving.map((entry, index) => {
    const base: Omit<LedgerEntry, "entryHash"> = { schemaVersion: 1, kind: "ghostapi.action-ledger-entry", tenantId, sequence: index + 1, timestamp: entry.timestamp, actionId: entry.actionId, actionHash: entry.actionHash, stage: entry.stage, data: entry.data, previousHash };
    const entryHash = sha256(canonicalJson(base));
    previousHash = entryHash;
    return { ...base, entryHash };
  });
}

function getOrCreateTenant(state: ActionLedgerState, tenantId: string): LedgerTenantState {
  const existing = state.tenants.find((tenant) => tenant.tenantId === tenantId);
  if (existing !== undefined) return existing;
  if (state.tenants.length >= MAX_TENANTS) throw new ActionLedgerError(`Action ledger tenant limit of ${MAX_TENANTS} was reached.`);
  const tenant: LedgerTenantState = { tenantId, entryCount: 0, headHash: genesisHash(tenantId), retentionDays: null, legalHold: false };
  state.tenants.push(tenant);
  return tenant;
}

function assertTenantIntegrity(state: ActionLedgerState, tenantId: string): void {
  const result = verifyTenantState(state, tenantId);
  if (!result.valid) throw new ActionLedgerError(result.error);
}

function verifyTenantState(state: ActionLedgerState, tenantId: string): LedgerVerification {
  const tenant = state.tenants.find((candidate) => candidate.tenantId === tenantId);
  if (tenant === undefined) return { valid: true, entryCount: 0, headHash: genesisHash(tenantId), tracked: false };
  const entries = state.entries.filter((entry) => entry.tenantId === tenantId);
  if (entries.length !== tenant.entryCount) return { valid: false, error: "Ledger tenant entry count does not match the append-only record." };
  let previousHash = genesisHash(tenantId);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.sequence !== index + 1 || entry.previousHash !== previousHash) return { valid: false, error: "Ledger entry ordering or chain link is corrupted." };
    const expectedHash = sha256(canonicalJson({ schemaVersion: entry.schemaVersion, kind: entry.kind, tenantId: entry.tenantId, sequence: entry.sequence, timestamp: entry.timestamp, actionId: entry.actionId, actionHash: entry.actionHash, stage: entry.stage, data: entry.data, previousHash: entry.previousHash }));
    if (entry.entryHash !== expectedHash) return { valid: false, error: "Ledger entry content hash is corrupted." };
    previousHash = entry.entryHash;
  }
  if (tenant.headHash !== previousHash) return { valid: false, error: "Ledger tenant head hash does not match the append-only record." };
  return { valid: true, entryCount: entries.length, headHash: tenant.headHash, tracked: true };
}

function entriesForAction(state: ActionLedgerState, tenantId: string, actionId: string): LedgerEntry[] {
  return state.entries.filter((entry) => entry.tenantId === tenantId && entry.actionId === actionId).map((entry) => structuredClone(entry));
}

function normalizeData(value: unknown): Record<string, string | number | boolean | null> {
  const data = object(value, "Ledger structured data must be an object.");
  const entries = Object.entries(data);
  if (entries.length > 16) throw new ActionLedgerError("Ledger structured data has too many fields.");
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of entries) {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) || /(?:authorization|cookie|token|secret|password|email|phone|address|card|payload|body)/i.test(key)) throw new ActionLedgerError(`Ledger structured field is forbidden: ${key}`);
    if (typeof entry === "string") normalized[key] = safeString(entry, `Ledger structured field ${key}`, 512);
    else if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new ActionLedgerError(`Ledger structured field ${key} must be finite.`);
      normalized[key] = entry;
    } else if (typeof entry === "boolean" || entry === null) normalized[key] = entry;
    else throw new ActionLedgerError(`Ledger structured field ${key} must be scalar.`);
  }
  return normalized;
}

function normalizeFixtureHeaders(value: unknown): Record<string, string> {
  const headers = object(value ?? {}, "Incident fixture request headers are invalid.");
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(headers)) {
    if (key.toLowerCase() !== "content-type" || typeof entry !== "string") throw new ActionLedgerError("Incident fixture contains an unsafe request header.");
    normalized["content-type"] = safeString(entry, "Incident fixture content type", 128);
  }
  return normalized;
}

function sanitizeStructured(value: unknown, label: string): unknown {
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new ActionLedgerError(`${label} exceeds 65536 bytes.`);
  const sanitized = sanitizeSecretString(serialized);
  if (sanitized !== serialized || /(?:@|\b\d{3}[ .-]\d{3}[ .-]\d{4}\b)/.test(serialized)) throw new ActionLedgerError(`${label} contains a secret-shaped value or prohibited PII.`);
  return structuredClone(value);
}

function accessTenantId(value: unknown): string {
  if (value === null || typeof value !== "object") throw new ActionLedgerError("Ledger access is not a verified capability.");
  const tenantId = (value as { tenantId?: unknown }).tenantId;
  // Test capabilities deliberately expose no mutable fields, so authorizers receive an opaque scope hint instead.
  return typeof tenantId === "string" ? identifier(tenantId, "Ledger tenant id") : "opaque";
}

function denyLedgerAccess(): never {
  throw new ActionLedgerError("Ledger access is disabled until a verified tenant access authorizer is configured.");
}

function governanceActionId(kind: string, state: ActionLedgerState, tenantId: string): string {
  return `governance-${kind}-${tenantId}-${state.entries.filter((entry) => entry.tenantId === tenantId).length + 1}`.slice(0, 128);
}

function deterministicUuid(digest: string): string {
  const hex = digest.slice(0, 12) + "4" + digest.slice(13, 16) + "8" + digest.slice(17, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function readOutcome(value: unknown): "verified" | "requires_reconciliation" {
  const body = object(value, "Incident replay response body is invalid.");
  return body.outcome === "verified" || body.outcome === "requires_reconciliation" ? body.outcome : (() => { throw new ActionLedgerError("Incident replay response outcome is invalid."); })();
}

function isStage(value: unknown): value is LedgerStage {
  return value === "intent" || value === "identity" || value === "policy_decision" || value === "approval" || value === "credential_grant" || value === "execution_attempt" || value === "provider_receipt" || value === "verification" || value === "compensation" || value === "retention" || value === "legal_hold" || value === "deletion_request";
}

function normalizePermissions(value: readonly LedgerPermission[]): LedgerPermission[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((permission) => !["append", "read", "export", "manage_retention", "manage_hold", "request_deletion"].includes(permission)) || new Set(value).size !== value.length) throw new ActionLedgerError("Ledger permissions are invalid.");
  return [...value];
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ActionLedgerError(message);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  for (const key of Object.keys(value)) if (!expected.includes(key)) throw new ActionLedgerError(`${label} contains unsupported field: ${key}`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || sanitizeSecretString(value) !== value) throw new ActionLedgerError(`${label} must be a safe stable identifier.`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new ActionLedgerError(`${label} must be a SHA-256 hex digest.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) throw new ActionLedgerError(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) throw new ActionLedgerError(`${label} must be a non-negative integer.`);
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) throw new ActionLedgerError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ActionLedgerError(`${label} must be an ISO UTC timestamp.`);
  return value;
}

function safeString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || sanitizeSecretString(value) !== value) throw new ActionLedgerError(`${label} must be a bounded non-secret string.`);
  return value;
}

function genesisHash(tenantId: string): string {
  return sha256(`ghostapi.action-ledger.v1:${tenantId}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ActionLedgerError("Ledger values must be finite JSON data.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new ActionLedgerError("Ledger values must be JSON data.");
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
