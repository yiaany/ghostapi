import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";

const SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_CREDENTIALS = 1_000;
const MAX_GRANTS = 10_000;
const MAX_RECEIPTS = 10_000;
const MAX_SCOPES = 16;
const MAX_GRANT_TTL_MS = 15 * 60 * 1000;
const MAX_BREAK_GLASS_TTL_MS = 5 * 60 * 1000;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const REFERENCE = /^[a-z0-9][a-z0-9._:/-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;

export type WorkloadKind = "agent_run" | "ci_job" | "production_service";
export type WorkloadIdentity = {
  schemaVersion: 1;
  kind: "ghostapi.workload-identity";
  tenantId: string;
  projectId: string;
  environment: string;
  workloadId: string;
  subjectId: string;
  workloadKind: WorkloadKind;
  runId: string;
  issuedAt: string;
  expiresAt: string;
};

export type WorkloadBinding = Pick<WorkloadIdentity, "tenantId" | "projectId" | "environment" | "workloadId" | "workloadKind">;
export type CredentialActionReference = { actionId: string; actionHash: string; actionReceiptHash: string };
export type CredentialAccessRequest = {
  credentialId: string;
  provider: string;
  scopes: string[];
  audience: "ghostapi-server";
  action: CredentialActionReference;
};

export type CredentialMetadata = {
  id: string;
  tenantId: string;
  projectId: string;
  environment: string;
  provider: string;
  ownerWorkloadId: string;
  ownerWorkloadKind: WorkloadKind;
  vaultRef: string;
  allowedScopes: string[];
  version: number;
  createdAt: string;
  expiresAt: string;
  rotatedAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
};

export type CredentialGrant = {
  id: string;
  credentialId: string;
  credentialVersion: number;
  tenantId: string;
  projectId: string;
  environment: string;
  workloadId: string;
  workloadKind: WorkloadKind;
  provider: string;
  scopes: string[];
  audience: "ghostapi-server";
  action: CredentialActionReference;
  issuedAt: string;
  expiresAt: string;
  breakGlass?: { approvalId: string; approvedBy: string; reason: string };
  revokedAt?: string;
};

export type CredentialUseReceipt = {
  id: string;
  grantId: string;
  credentialId: string;
  credentialVersion: number;
  tenantId: string;
  workloadId: string;
  action: CredentialActionReference;
  status: "executed" | "failed";
  providerRequestId?: string;
  failureCode?: "execution_failed";
  executedAt: string;
};

export type CredentialBrokerState = {
  schemaVersion: 1;
  credentials: CredentialMetadata[];
  grants: CredentialGrant[];
  receipts: CredentialUseReceipt[];
};

export interface CredentialVault {
  readonly kind: "external-vault" | "test-memory-vault";
  readSecret(vaultRef: string): Promise<Uint8Array>;
}

export interface CredentialExecutor {
  readonly provider: string;
  supportsScope(scope: string): boolean;
  execute(input: { secret: Uint8Array; grant: CredentialGrant; workload: WorkloadIdentity }): Promise<{ providerRequestId: string }>;
}

export interface ActionReceiptVerifier {
  verify(reference: CredentialActionReference, workload: WorkloadIdentity): Promise<void>;
}

export interface WorkloadIdentityVerifier {
  authenticate(identity: unknown): Promise<WorkloadIdentity>;
  isActive?(binding: WorkloadBinding): Promise<boolean>;
}

export type BreakGlassApproval = {
  schemaVersion: 1;
  kind: "ghostapi.break-glass-approval";
  approvalId: string;
  action: CredentialActionReference;
  approvedBy: string;
  reason: string;
  issuedAt: string;
  expiresAt: string;
};

export interface BreakGlassAuthorizer {
  authorize(approval: unknown, workload: WorkloadIdentity, request: CredentialAccessRequest): Promise<{ approvalId: string; approvedBy: string; reason: string }>;
}

export type CredentialBrokerOptions = {
  path?: string;
  now?: () => Date;
  vault: CredentialVault;
  executor: CredentialExecutor;
  workloadVerifier: WorkloadIdentityVerifier;
  actionReceiptVerifier: ActionReceiptVerifier;
  breakGlassAuthorizer?: BreakGlassAuthorizer;
};

export class CredentialBrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialBrokerError";
  }
}

export function createCredentialBroker(options: CredentialBrokerOptions): CredentialBroker {
  return new CredentialBroker(options);
}

export class CredentialBroker {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly vault: CredentialVault;
  private readonly executor: CredentialExecutor;
  private readonly workloadVerifier: WorkloadIdentityVerifier;
  private readonly actionReceiptVerifier: ActionReceiptVerifier;
  private readonly breakGlassAuthorizer: BreakGlassAuthorizer;

  constructor(options: CredentialBrokerOptions) {
    this.path = options.path ?? getDataPaths().credentialBroker;
    this.now = options.now ?? (() => new Date());
    this.vault = options.vault;
    this.executor = options.executor;
    this.workloadVerifier = options.workloadVerifier;
    this.actionReceiptVerifier = options.actionReceiptVerifier;
    this.breakGlassAuthorizer = options.breakGlassAuthorizer ?? createDisabledBreakGlassAuthorizer();
  }

  async registerCredential(input: Omit<CredentialMetadata, "version" | "createdAt" | "rotatedAt" | "revokedAt" | "lastUsedAt">): Promise<CredentialMetadata> {
    const candidate = validateCredentialMetadata({ ...input, version: 1, createdAt: this.timestamp(), expiresAt: input.expiresAt });
    return this.mutate((state) => {
      if (state.credentials.some((credential) => credential.tenantId === candidate.tenantId && credential.id === candidate.id)) throw new CredentialBrokerError("Credential already exists.");
      state.credentials.push(candidate);
      return clone(candidate);
    });
  }

  async rotateCredential(input: { tenantId: string; credentialId: string; vaultRef: string; expiresAt: string }): Promise<CredentialMetadata> {
    const tenantId = identifier(input.tenantId, "Credential tenant id");
    const credentialId = identifier(input.credentialId, "Credential id");
    const vaultRef = reference(input.vaultRef, "Credential vault reference");
    const expiresAt = futureTimestamp(input.expiresAt, this.timestamp(), "Credential expiry");
    return this.mutate((state, now) => {
      const credential = findCredential(state, tenantId, credentialId);
      if (credential.revokedAt !== undefined) throw new CredentialBrokerError("Credential is revoked.");
      credential.vaultRef = vaultRef;
      credential.expiresAt = expiresAt;
      credential.version += 1;
      credential.rotatedAt = now;
      for (const grant of state.grants) if (grant.tenantId === tenantId && grant.credentialId === credentialId && grant.revokedAt === undefined) grant.revokedAt = now;
      return clone(credential);
    });
  }

  async revokeCredential(tenantIdValue: string, credentialIdValue: string): Promise<void> {
    const tenantId = identifier(tenantIdValue, "Credential tenant id");
    const credentialId = identifier(credentialIdValue, "Credential id");
    await this.mutate((state, now) => {
      const credential = findCredential(state, tenantId, credentialId);
      if (credential.revokedAt === undefined) credential.revokedAt = now;
      for (const grant of state.grants) if (grant.tenantId === tenantId && grant.credentialId === credentialId && grant.revokedAt === undefined) grant.revokedAt = now;
    });
  }

  async issueGrant(input: { identity: unknown; request: CredentialAccessRequest; expiresAt: string; breakGlassApproval?: unknown }): Promise<CredentialGrant> {
    const workload = await this.authenticateWorkload(input.identity);
    const request = validateAccessRequest(input.request);
    const expiresAt = futureTimestamp(input.expiresAt, this.timestamp(), "Credential grant expiry");
    return this.mutate(async (state, now) => {
      const credential = findCredential(state, workload.tenantId, request.credentialId);
      assertCredentialUsable(credential, now);
      assertRequestMatchesCredential(request, credential, workload);
      const normalOwnerMatch = credential.ownerWorkloadId === workload.workloadId && credential.ownerWorkloadKind === workload.workloadKind;
      const breakGlass = normalOwnerMatch ? undefined : await this.breakGlassAuthorizer.authorize(input.breakGlassApproval, workload, request);
      if (breakGlass !== undefined && Date.parse(expiresAt) - Date.parse(now) > MAX_BREAK_GLASS_TTL_MS) throw new CredentialBrokerError("Break-glass grants must expire within five minutes.");
      if (Date.parse(expiresAt) - Date.parse(now) > MAX_GRANT_TTL_MS) throw new CredentialBrokerError("Credential grants must expire within fifteen minutes.");
      if (Date.parse(expiresAt) > Date.parse(credential.expiresAt) || Date.parse(expiresAt) > Date.parse(workload.expiresAt)) throw new CredentialBrokerError("Credential grant expiry exceeds its credential or workload lifetime.");
      const grant: CredentialGrant = {
        id: identifier(`grant-${randomUUID().replace(/-/g, "")}`, "Credential grant id"),
        credentialId: credential.id,
        credentialVersion: credential.version,
        tenantId: credential.tenantId,
        projectId: credential.projectId,
        environment: credential.environment,
        workloadId: workload.workloadId,
        workloadKind: workload.workloadKind,
        provider: credential.provider,
        scopes: [...request.scopes],
        audience: "ghostapi-server",
        action: clone(request.action),
        issuedAt: now,
        expiresAt,
        ...(breakGlass === undefined ? {} : { breakGlass })
      };
      state.grants.push(grant);
      return clone(grant);
    });
  }

  async executeServerSide(input: { identity: unknown; grantId: string; request: CredentialAccessRequest }): Promise<CredentialUseReceipt> {
    const workload = await this.authenticateWorkload(input.identity);
    const grantId = identifier(input.grantId, "Credential grant id");
    const request = validateAccessRequest(input.request);
    const outcome: { receipt: CredentialUseReceipt; failed?: never } | { failed: true; receipt?: never } = await this.mutate(async (state, now) => {
      const grant = state.grants.find((candidate) => candidate.id === grantId);
      if (grant === undefined) throw new CredentialBrokerError("Credential grant was not found.");
      assertGrantUsable(grant, workload, request, now);
      const credential = findCredential(state, workload.tenantId, grant.credentialId);
      assertCredentialUsable(credential, now);
      if (credential.version !== grant.credentialVersion) throw new CredentialBrokerError("Credential grant was invalidated by rotation.");
      if (credential.provider !== this.executor.provider || !grant.scopes.every((scope) => this.executor.supportsScope(scope))) throw new CredentialBrokerError("Credential executor denies the requested scope.");
      const prior = state.receipts.find((receipt) => receipt.grantId === grant.id);
      if (prior !== undefined) {
        if (prior.status === "executed") return { receipt: clone(prior) };
        throw new CredentialBrokerError("Prior credential execution failed and will not retry automatically.");
      }
      await this.actionReceiptVerifier.verify(request.action, workload);
      let secret: Uint8Array | undefined;
      try {
        secret = await this.vault.readSecret(credential.vaultRef);
        if (!(secret instanceof Uint8Array) || secret.byteLength === 0 || secret.byteLength > 64 * 1024) throw new CredentialBrokerError("Credential vault returned invalid secret material.");
        const result = await this.executor.execute({ secret, grant: clone(grant), workload: clone(workload) });
        const receipt: CredentialUseReceipt = { id: identifier(`credential-use-${randomUUID().replace(/-/g, "")}`, "Credential use receipt id"), grantId: grant.id, credentialId: credential.id, credentialVersion: credential.version, tenantId: credential.tenantId, workloadId: workload.workloadId, action: clone(grant.action), status: "executed", providerRequestId: identifier(result.providerRequestId, "Provider request id"), executedAt: now };
        state.receipts.push(receipt);
        credential.lastUsedAt = now;
        return { receipt: clone(receipt) };
      } catch {
        const receipt: CredentialUseReceipt = { id: identifier(`credential-use-${randomUUID().replace(/-/g, "")}`, "Credential use receipt id"), grantId: grant.id, credentialId: credential.id, credentialVersion: credential.version, tenantId: credential.tenantId, workloadId: workload.workloadId, action: clone(grant.action), status: "failed", failureCode: "execution_failed", executedAt: now };
        state.receipts.push(receipt);
        return { failed: true };
      } finally {
        secret?.fill(0);
      }
    });
    if (outcome.failed) throw new CredentialBrokerError("Credential execution failed without a usable receipt.");
    return outcome.receipt;
  }

  async listOrphanedCredentials(): Promise<CredentialMetadata[]> {
    const state = await this.read();
    const candidates = state.credentials.filter((credential) => credential.revokedAt === undefined);
    const results = await Promise.all(candidates.map(async (credential) => {
      const active = this.workloadVerifier.isActive === undefined ? false : await this.workloadVerifier.isActive({ tenantId: credential.tenantId, projectId: credential.projectId, environment: credential.environment, workloadId: credential.ownerWorkloadId, workloadKind: credential.ownerWorkloadKind });
      return active ? undefined : clone(credential);
    }));
    return results.filter((credential): credential is CredentialMetadata => credential !== undefined);
  }

  async inspectCredential(tenantIdValue: string, credentialIdValue: string): Promise<CredentialMetadata> {
    const credential = findCredential(await this.read(), identifier(tenantIdValue, "Credential tenant id"), identifier(credentialIdValue, "Credential id"));
    return clone(credential);
  }

  async readStateForTesting(): Promise<CredentialBrokerState> {
    return this.read();
  }

  private async authenticateWorkload(identity: unknown): Promise<WorkloadIdentity> {
    const workload = await this.workloadVerifier.authenticate(identity);
    return validateWorkloadIdentity(workload, this.timestamp());
  }

  private async read(): Promise<CredentialBrokerState> {
    await ensurePrivateDirectory(dirname(this.path));
    const info = await lstat(this.path).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
    if (info === null) return emptyState();
    if (!info.isFile() || info.isSymbolicLink()) throw new CredentialBrokerError("Credential broker store must be a regular non-symlink file.");
    const source = await readFile(this.path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_STORE_BYTES) throw new CredentialBrokerError(`Credential broker store exceeds ${MAX_STORE_BYTES} bytes.`);
    try {
      return validateState(JSON.parse(source));
    } catch (error) {
      if (error instanceof CredentialBrokerError) throw error;
      throw new CredentialBrokerError("Credential broker store is not valid JSON.");
    }
  }

  private async mutate<T>(operation: (state: CredentialBrokerState, now: string) => T | Promise<T>): Promise<T> {
    return withFileLock(this.path, async () => {
      const state = await this.read();
      const result = await operation(state, this.timestamp());
      await atomicWriteJson(this.path, validateState(state));
      return result;
    });
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new CredentialBrokerError("Credential broker clock is invalid.");
    return value.toISOString();
  }
}

export function createDisabledBreakGlassAuthorizer(): BreakGlassAuthorizer {
  return { async authorize(): Promise<never> { throw new CredentialBrokerError("Break-glass authorization is not configured."); } };
}

export function createTestActionReceiptVerifier(reference: CredentialActionReference): { verifier: ActionReceiptVerifier; calls: number } {
  let calls = 0;
  return {
    verifier: {
      async verify(candidate: CredentialActionReference): Promise<void> {
        calls += 1;
        if (!sameAction(reference, candidate)) throw new CredentialBrokerError("Action receipt does not authorize this credential use.");
      }
    },
    get calls() { return calls; }
  };
}

export function createTestCredentialVault(): { vault: CredentialVault; put(vaultRef: string, material: Uint8Array): void } {
  const values = new Map<string, Uint8Array>();
  return {
    vault: {
      kind: "test-memory-vault",
      async readSecret(vaultRef: string): Promise<Uint8Array> {
        const value = values.get(reference(vaultRef, "Credential vault reference"));
        if (value === undefined) throw new CredentialBrokerError("Credential vault reference was not found.");
        return new Uint8Array(value);
      }
    },
    put(vaultRef: string, material: Uint8Array): void {
      if (!(material instanceof Uint8Array) || material.byteLength === 0 || material.byteLength > 64 * 1024) throw new CredentialBrokerError("Test credential material is invalid.");
      values.set(reference(vaultRef, "Credential vault reference"), new Uint8Array(material));
    }
  };
}

export function createTestCredentialExecutor(): { executor: CredentialExecutor; executions: Array<{ grantId: string; secretLength: number }> } {
  const executions: Array<{ grantId: string; secretLength: number }> = [];
  return {
    executor: {
      provider: "test-provider",
      supportsScope: (scope) => scope === "test.execute",
      async execute(input): Promise<{ providerRequestId: string }> {
        if (input.grant.audience !== "ghostapi-server" || !input.grant.scopes.every((scope) => scope === "test.execute") || input.secret.byteLength === 0) throw new CredentialBrokerError("Test provider rejected credential execution.");
        executions.push({ grantId: input.grant.id, secretLength: input.secret.byteLength });
        return { providerRequestId: `test-provider-${input.grant.id}` };
      }
    },
    executions
  };
}

export function createTestWorkloadIdentityProvider(options: { now?: () => Date } = {}): { verifier: WorkloadIdentityVerifier; issue(input: Omit<WorkloadIdentity, "schemaVersion" | "kind">): WorkloadIdentity; deactivate(workloadId: string): void } {
  const now = options.now ?? (() => new Date());
  const issued = new WeakSet<object>();
  const active = new Set<string>();
  return {
    verifier: {
      async authenticate(identity: unknown): Promise<WorkloadIdentity> {
        if (identity === null || typeof identity !== "object" || !issued.has(identity)) throw new CredentialBrokerError("Workload identity is not authenticated.");
        const workload = validateWorkloadIdentity(identity, timestampFrom(now));
        if (!active.has(workloadKey(workload))) throw new CredentialBrokerError("Workload identity is inactive.");
        return clone(workload);
      },
      async isActive(binding: WorkloadBinding): Promise<boolean> {
        return active.has(workloadKey(binding));
      }
    },
    issue(input): WorkloadIdentity {
      const workload = validateWorkloadIdentity({ schemaVersion: 1, kind: "ghostapi.workload-identity", ...input }, timestampFrom(now));
      const frozen = Object.freeze(clone(workload));
      issued.add(frozen);
      active.add(workloadKey(workload));
      return frozen;
    },
    deactivate(workloadId: string): void {
      const id = identifier(workloadId, "Workload id");
      for (const key of [...active]) if (key.endsWith(`:${id}`)) active.delete(key);
    }
  };
}

export function createTestBreakGlassAuthorizer(options: { now?: () => Date } = {}): { authorizer: BreakGlassAuthorizer; issue(input: Omit<BreakGlassApproval, "schemaVersion" | "kind">): BreakGlassApproval } {
  const now = options.now ?? (() => new Date());
  const issued = new WeakSet<object>();
  return {
    authorizer: {
      async authorize(approval: unknown, workload: WorkloadIdentity, request: CredentialAccessRequest): Promise<{ approvalId: string; approvedBy: string; reason: string }> {
        if (approval === null || typeof approval !== "object" || !issued.has(approval)) throw new CredentialBrokerError("Break-glass approval is not trusted.");
        const parsed = validateBreakGlassApproval(approval, timestampFrom(now));
        if (parsed.approvedBy === workload.subjectId || parsed.approvedBy === workload.workloadId || !sameAction(parsed.action, request.action)) throw new CredentialBrokerError("Break-glass approval does not authorize this workload action.");
        return { approvalId: parsed.approvalId, approvedBy: parsed.approvedBy, reason: parsed.reason };
      }
    },
    issue(input): BreakGlassApproval {
      const approval = validateBreakGlassApproval({ schemaVersion: 1, kind: "ghostapi.break-glass-approval", ...input }, timestampFrom(now));
      const frozen = Object.freeze(clone(approval));
      issued.add(frozen);
      return frozen;
    }
  };
}

function emptyState(): CredentialBrokerState {
  return { schemaVersion: 1, credentials: [], grants: [], receipts: [] };
}

function validateState(value: unknown): CredentialBrokerState {
  const state = object(value, "Credential broker store must be an object.");
  exactKeys(state, ["schemaVersion", "credentials", "grants", "receipts"], "Credential broker store");
  if (state.schemaVersion !== SCHEMA_VERSION) throw new CredentialBrokerError("Unsupported credential broker schema version.");
  const credentials = array(state.credentials, "Credentials", MAX_CREDENTIALS).map(validateCredentialMetadata);
  unique(credentials.map((credential) => `${credential.tenantId}:${credential.id}`), "Credential ids");
  const grants = array(state.grants, "Credential grants", MAX_GRANTS).map(validateGrant);
  unique(grants.map((grant) => grant.id), "Credential grant ids");
  for (const grant of grants) {
    const credential = credentials.find((candidate) => candidate.tenantId === grant.tenantId && candidate.id === grant.credentialId);
    if (credential === undefined || grant.credentialVersion > credential.version || grant.provider !== credential.provider || !grant.scopes.every((scope) => credential.allowedScopes.includes(scope))) throw new CredentialBrokerError("Credential grant references an invalid credential.");
  }
  const receipts = array(state.receipts, "Credential use receipts", MAX_RECEIPTS).map(validateReceipt);
  unique(receipts.map((receipt) => receipt.id), "Credential use receipt ids");
  unique(receipts.map((receipt) => receipt.grantId), "Credential use receipt grants");
  for (const receipt of receipts) {
    const grant = grants.find((candidate) => candidate.id === receipt.grantId);
    if (grant === undefined || receipt.credentialId !== grant.credentialId || receipt.credentialVersion !== grant.credentialVersion || receipt.tenantId !== grant.tenantId || receipt.workloadId !== grant.workloadId || !sameAction(receipt.action, grant.action)) throw new CredentialBrokerError("Credential use receipt references an invalid grant.");
  }
  return { schemaVersion: 1, credentials, grants, receipts };
}

function validateCredentialMetadata(value: unknown): CredentialMetadata {
  const metadata = object(value, "Credential metadata is invalid.");
  exactKeys(metadata, ["id", "tenantId", "projectId", "environment", "provider", "ownerWorkloadId", "ownerWorkloadKind", "vaultRef", "allowedScopes", "version", "createdAt", "expiresAt", "rotatedAt", "revokedAt", "lastUsedAt"], "Credential metadata", ["rotatedAt", "revokedAt", "lastUsedAt"]);
  const createdAt = timestamp(metadata.createdAt, "Credential creation time");
  const expiresAt = timestamp(metadata.expiresAt, "Credential expiry");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new CredentialBrokerError("Credential expiry must follow creation.");
  return { id: identifier(metadata.id, "Credential id"), tenantId: identifier(metadata.tenantId, "Credential tenant id"), projectId: identifier(metadata.projectId, "Credential project id"), environment: identifier(metadata.environment, "Credential environment"), provider: identifier(metadata.provider, "Credential provider"), ownerWorkloadId: identifier(metadata.ownerWorkloadId, "Credential owner workload id"), ownerWorkloadKind: workloadKind(metadata.ownerWorkloadKind), vaultRef: reference(metadata.vaultRef, "Credential vault reference"), allowedScopes: scopes(metadata.allowedScopes, "Credential allowed scopes"), version: positiveInteger(metadata.version, "Credential version"), createdAt, expiresAt, ...(metadata.rotatedAt === undefined ? {} : { rotatedAt: timestamp(metadata.rotatedAt, "Credential rotation time") }), ...(metadata.revokedAt === undefined ? {} : { revokedAt: timestamp(metadata.revokedAt, "Credential revocation time") }), ...(metadata.lastUsedAt === undefined ? {} : { lastUsedAt: timestamp(metadata.lastUsedAt, "Credential last use time") }) };
}

function validateGrant(value: unknown): CredentialGrant {
  const grant = object(value, "Credential grant is invalid.");
  exactKeys(grant, ["id", "credentialId", "credentialVersion", "tenantId", "projectId", "environment", "workloadId", "workloadKind", "provider", "scopes", "audience", "action", "issuedAt", "expiresAt", "breakGlass", "revokedAt"], "Credential grant", ["breakGlass", "revokedAt"]);
  const issuedAt = timestamp(grant.issuedAt, "Credential grant issue time");
  const expiresAt = timestamp(grant.expiresAt, "Credential grant expiry");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) || Date.parse(expiresAt) - Date.parse(issuedAt) > MAX_GRANT_TTL_MS) throw new CredentialBrokerError("Credential grant lifetime is invalid.");
  const breakGlass = grant.breakGlass === undefined ? undefined : breakGlassRecord(grant.breakGlass);
  if (breakGlass !== undefined && Date.parse(expiresAt) - Date.parse(issuedAt) > MAX_BREAK_GLASS_TTL_MS) throw new CredentialBrokerError("Break-glass grant lifetime is invalid.");
  if (grant.audience !== "ghostapi-server") throw new CredentialBrokerError("Credential grant audience is invalid.");
  return { id: identifier(grant.id, "Credential grant id"), credentialId: identifier(grant.credentialId, "Credential id"), credentialVersion: positiveInteger(grant.credentialVersion, "Credential version"), tenantId: identifier(grant.tenantId, "Credential tenant id"), projectId: identifier(grant.projectId, "Credential project id"), environment: identifier(grant.environment, "Credential environment"), workloadId: identifier(grant.workloadId, "Credential workload id"), workloadKind: workloadKind(grant.workloadKind), provider: identifier(grant.provider, "Credential provider"), scopes: scopes(grant.scopes, "Credential grant scopes"), audience: "ghostapi-server", action: actionReference(grant.action), issuedAt, expiresAt, ...(breakGlass === undefined ? {} : { breakGlass }), ...(grant.revokedAt === undefined ? {} : { revokedAt: timestamp(grant.revokedAt, "Credential grant revocation time") }) };
}

function validateReceipt(value: unknown): CredentialUseReceipt {
  const receipt = object(value, "Credential use receipt is invalid.");
  exactKeys(receipt, ["id", "grantId", "credentialId", "credentialVersion", "tenantId", "workloadId", "action", "status", "providerRequestId", "failureCode", "executedAt"], "Credential use receipt", ["providerRequestId", "failureCode"]);
  if (receipt.status !== "executed" && receipt.status !== "failed") throw new CredentialBrokerError("Credential use receipt status is invalid.");
  if (receipt.status === "executed" && (receipt.failureCode !== undefined || receipt.providerRequestId === undefined)) throw new CredentialBrokerError("Executed credential receipt is invalid.");
  if (receipt.status === "failed" && (receipt.failureCode !== "execution_failed" || receipt.providerRequestId !== undefined)) throw new CredentialBrokerError("Failed credential receipt is invalid.");
  return { id: identifier(receipt.id, "Credential use receipt id"), grantId: identifier(receipt.grantId, "Credential grant id"), credentialId: identifier(receipt.credentialId, "Credential id"), credentialVersion: positiveInteger(receipt.credentialVersion, "Credential version"), tenantId: identifier(receipt.tenantId, "Credential tenant id"), workloadId: identifier(receipt.workloadId, "Credential workload id"), action: actionReference(receipt.action), status: receipt.status, ...(receipt.providerRequestId === undefined ? {} : { providerRequestId: identifier(receipt.providerRequestId, "Provider request id") }), ...(receipt.failureCode === undefined ? {} : { failureCode: "execution_failed" as const }), executedAt: timestamp(receipt.executedAt, "Credential execution time") };
}

function validateAccessRequest(value: unknown): CredentialAccessRequest {
  const request = object(value, "Credential access request is invalid.");
  exactKeys(request, ["credentialId", "provider", "scopes", "audience", "action"], "Credential access request");
  if (request.audience !== "ghostapi-server") throw new CredentialBrokerError("Credential access request audience is invalid.");
  return { credentialId: identifier(request.credentialId, "Credential id"), provider: identifier(request.provider, "Credential provider"), scopes: scopes(request.scopes, "Credential request scopes"), audience: "ghostapi-server", action: actionReference(request.action) };
}

function validateWorkloadIdentity(value: unknown, now: string): WorkloadIdentity {
  const identity = object(value, "Workload identity is invalid.");
  exactKeys(identity, ["schemaVersion", "kind", "tenantId", "projectId", "environment", "workloadId", "subjectId", "workloadKind", "runId", "issuedAt", "expiresAt"], "Workload identity");
  if (identity.schemaVersion !== SCHEMA_VERSION || identity.kind !== "ghostapi.workload-identity") throw new CredentialBrokerError("Unsupported workload identity schema.");
  const issuedAt = timestamp(identity.issuedAt, "Workload identity issue time");
  const expiresAt = timestamp(identity.expiresAt, "Workload identity expiry");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) || Date.parse(expiresAt) <= Date.parse(now)) throw new CredentialBrokerError("Workload identity is expired.");
  return { schemaVersion: 1, kind: "ghostapi.workload-identity", tenantId: identifier(identity.tenantId, "Workload tenant id"), projectId: identifier(identity.projectId, "Workload project id"), environment: identifier(identity.environment, "Workload environment"), workloadId: identifier(identity.workloadId, "Workload id"), subjectId: identifier(identity.subjectId, "Workload subject id"), workloadKind: workloadKind(identity.workloadKind), runId: identifier(identity.runId, "Workload run id"), issuedAt, expiresAt };
}

function validateBreakGlassApproval(value: unknown, now: string): BreakGlassApproval {
  const approval = object(value, "Break-glass approval is invalid.");
  exactKeys(approval, ["schemaVersion", "kind", "approvalId", "action", "approvedBy", "reason", "issuedAt", "expiresAt"], "Break-glass approval");
  if (approval.schemaVersion !== SCHEMA_VERSION || approval.kind !== "ghostapi.break-glass-approval") throw new CredentialBrokerError("Unsupported break-glass approval schema.");
  const issuedAt = timestamp(approval.issuedAt, "Break-glass issue time");
  const expiresAt = timestamp(approval.expiresAt, "Break-glass expiry");
  if (Date.parse(issuedAt) > Date.parse(now) || Date.parse(expiresAt) <= Date.parse(now) || Date.parse(expiresAt) - Date.parse(issuedAt) > MAX_BREAK_GLASS_TTL_MS) throw new CredentialBrokerError("Break-glass approval is expired or exceeds five minutes.");
  return { schemaVersion: 1, kind: "ghostapi.break-glass-approval", approvalId: identifier(approval.approvalId, "Break-glass approval id"), action: actionReference(approval.action), approvedBy: identifier(approval.approvedBy, "Break-glass approver id"), reason: text(approval.reason, "Break-glass reason", 200), issuedAt, expiresAt };
}

function breakGlassRecord(value: unknown): { approvalId: string; approvedBy: string; reason: string } {
  const record = object(value, "Break-glass record is invalid.");
  exactKeys(record, ["approvalId", "approvedBy", "reason"], "Break-glass record");
  return { approvalId: identifier(record.approvalId, "Break-glass approval id"), approvedBy: identifier(record.approvedBy, "Break-glass approver id"), reason: text(record.reason, "Break-glass reason", 200) };
}

function actionReference(value: unknown): CredentialActionReference {
  const action = object(value, "Credential action reference is invalid.");
  exactKeys(action, ["actionId", "actionHash", "actionReceiptHash"], "Credential action reference");
  return { actionId: identifier(action.actionId, "Credential action id"), actionHash: hash(action.actionHash, "Credential action hash"), actionReceiptHash: hash(action.actionReceiptHash, "Credential action receipt hash") };
}

function assertCredentialUsable(credential: CredentialMetadata, now: string): void {
  if (credential.revokedAt !== undefined) throw new CredentialBrokerError("Credential is revoked.");
  if (Date.parse(credential.expiresAt) <= Date.parse(now)) throw new CredentialBrokerError("Credential is expired.");
}

function assertRequestMatchesCredential(request: CredentialAccessRequest, credential: CredentialMetadata, workload: WorkloadIdentity): void {
  if (request.provider !== credential.provider || workload.tenantId !== credential.tenantId || workload.projectId !== credential.projectId || workload.environment !== credential.environment) throw new CredentialBrokerError("Credential request crosses a tenant, project, environment, or provider boundary.");
  if (!request.scopes.every((scope) => credential.allowedScopes.includes(scope))) throw new CredentialBrokerError("Credential request exceeds the credential scope.");
}

function assertGrantUsable(grant: CredentialGrant, workload: WorkloadIdentity, request: CredentialAccessRequest, now: string): void {
  if (grant.revokedAt !== undefined || Date.parse(grant.expiresAt) <= Date.parse(now)) throw new CredentialBrokerError("Credential grant is expired or revoked.");
  if (grant.tenantId !== workload.tenantId || grant.projectId !== workload.projectId || grant.environment !== workload.environment || grant.workloadId !== workload.workloadId || grant.workloadKind !== workload.workloadKind) throw new CredentialBrokerError("Credential grant does not belong to this workload.");
  if (grant.credentialId !== request.credentialId || grant.provider !== request.provider || grant.audience !== request.audience || !sameScopes(grant.scopes, request.scopes) || !sameAction(grant.action, request.action)) throw new CredentialBrokerError("Credential request differs from the granted action.");
}

function findCredential(state: CredentialBrokerState, tenantId: string, credentialId: string): CredentialMetadata {
  const credential = state.credentials.find((candidate) => candidate.tenantId === tenantId && candidate.id === credentialId);
  if (credential === undefined) throw new CredentialBrokerError("Credential was not found.");
  return credential;
}

function scopes(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SCOPES) throw new CredentialBrokerError(`${label} must be a bounded non-empty list.`);
  const parsed = value.map((scope) => identifier(scope, label));
  if (new Set(parsed).size !== parsed.length) throw new CredentialBrokerError(`${label} must not contain duplicates.`);
  return parsed.sort();
}

function workloadKind(value: unknown): WorkloadKind {
  if (value !== "agent_run" && value !== "ci_job" && value !== "production_service") throw new CredentialBrokerError("Workload kind is invalid.");
  return value;
}

function sameScopes(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function sameAction(left: CredentialActionReference, right: CredentialActionReference): boolean {
  return left.actionId === right.actionId && left.actionHash === right.actionHash && left.actionReceiptHash === right.actionReceiptHash;
}

function workloadKey(binding: WorkloadBinding): string {
  return `${binding.tenantId}:${binding.projectId}:${binding.environment}:${binding.workloadKind}:${binding.workloadId}`;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || sanitizeSecretString(value) !== value) throw new CredentialBrokerError(`${label} must be a safe stable identifier.`);
  return value;
}

function reference(value: unknown, label: string): string {
  if (typeof value !== "string" || !REFERENCE.test(value) || sanitizeSecretString(value) !== value) throw new CredentialBrokerError(`${label} is invalid.`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new CredentialBrokerError(`${label} must be a SHA-256 hex digest.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new CredentialBrokerError(`${label} must be a positive integer.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new CredentialBrokerError(`${label} must be an ISO UTC timestamp.`);
  return value;
}

function futureTimestamp(value: unknown, now: string, label: string): string {
  const parsed = timestamp(value, label);
  if (Date.parse(parsed) <= Date.parse(now)) throw new CredentialBrokerError(`${label} must be in the future.`);
  return parsed;
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /[\u0000-\u001f]/.test(value) || sanitizeSecretString(value) !== value) throw new CredentialBrokerError(`${label} is invalid.`);
  return value;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new CredentialBrokerError(`${label} is invalid.`);
  return value;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CredentialBrokerError(message);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string, optional: string[] = []): void {
  for (const key of Object.keys(value)) if (!keys.includes(key) || (value[key] === undefined && !optional.includes(key))) throw new CredentialBrokerError(`${label} contains unsupported field: ${key}`);
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new CredentialBrokerError(`${label} must be unique.`);
}

function timestampFrom(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new CredentialBrokerError("Credential broker clock is invalid.");
  return value.toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
