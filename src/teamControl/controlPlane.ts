import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { validateEvidenceReport, type EvidenceReport } from "../evidence/index.js";
import type { GhostApiPolicy } from "../policy/index.js";
import { isSecretFieldName, sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";

const SCHEMA_VERSION = 3;
const MAX_STORE_BYTES = 1024 * 1024;
const TOKEN_PREFIX = "gapi_team_";
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_EVIDENCE_PER_ORGANIZATION = 100;
const MAX_AUDIT_PER_ORGANIZATION = 1_000;
const EVIDENCE_RETENTION_DAYS = 30;
const AUDIT_RETENTION_DAYS = 90;
const MAX_SERVICE_TOKEN_SCOPES = 20;
const authenticatedServiceActors = new WeakMap<object, () => Date>();

export type TeamRole = "owner" | "admin" | "developer" | "viewer" | "service_account";
export type TeamEnvironmentKind = "development" | "ci";
export type TeamPermission =
  | "member.manage"
  | "project.manage"
  | "environment.manage"
  | "policy.manage"
  | "token.manage"
  | "service_account.manage"
  | "audit.read"
  | "audit.export"
  | "data.delete"
  | "retention.manage"
  | "project.read"
  | "environment.read"
  | "scenario.read"
  | "evidence.read"
  | "policy.read"
  | "scenario.publish"
  | "evidence.upload";
export type TeamScopedPermission = Extract<TeamPermission, "project.read" | "environment.read" | "scenario.read" | "evidence.read" | "policy.read" | "scenario.publish" | "evidence.upload">;
export type TeamTokenScope = { projectId: string; environmentId: string; permissions: TeamScopedPermission[] };
export type TeamActor =
  | { organizationId: string; memberId: string; actorType?: "user" }
  | { organizationId: string; serviceAccountId: string; actorType: "service_account"; tokenId: string };
export type TeamAuthenticatedActor = TeamActor;
export type TeamOrganization = { id: string; name: string; createdAt: string };
export type TeamMember = { id: string; organizationId: string; role: Exclude<TeamRole, "service_account">; createdAt: string };
export type TeamServiceAccount = { id: string; organizationId: string; name: string; createdBy: string; createdAt: string; disabledAt?: string };
export type TeamProject = { id: string; organizationId: string; name: string; createdAt: string };
export type TeamEnvironment = { id: string; organizationId: string; projectId: string; name: string; kind: TeamEnvironmentKind; createdAt: string };
export type TeamScenarioVersion = { organizationId: string; projectId: string; environmentId: string; scenarioId: string; version: number; title: string; metadata: Record<string, unknown>; createdBy: string; createdAt: string };
export type TeamEvidence = {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  runId: string;
  evidenceHash: string;
  status: EvidenceReport["run"]["status"];
  passed: boolean;
  failCount: number;
  warningCount: number;
  providers: string[];
  scenarios: string[];
  enforcement: Pick<EvidenceReport["enforcement"], "mode" | "isolated" | "degraded">;
  uploadedBy: string;
  uploadedAt: string;
  expiresAt: string;
};
export type TeamPolicyVersion = { organizationId: string; version: number; policy: GhostApiPolicy; hash: string; distributedBy: string; distributedAt: string };
export type TeamAuditAnchor = { organizationId: string; sequence: number; hash: string };
export type TeamAuditRecord = { organizationId: string; sequence: number; actorId: string; action: string; resource: string; timestamp: string; previousHash: string; recordHash: string };
export type TeamAuditExport = { organizationId: string; anchor: TeamAuditAnchor; records: TeamAuditRecord[]; integrity: { valid: boolean; reason?: string } };
export type TeamAuditIntegrity = TeamAuditExport["integrity"];
type TeamToken = { id: string; organizationId: string; type: "user" | "service"; subjectId: string; digest: string; issuedBy: string; issuedAt: string; expiresAt: string; scope?: TeamTokenScope[]; revokedAt?: string };
export type TeamControlPlaneState = { schemaVersion: 3; organizations: TeamOrganization[]; members: TeamMember[]; serviceAccounts: TeamServiceAccount[]; projects: TeamProject[]; environments: TeamEnvironment[]; tokens: TeamToken[]; scenarios: TeamScenarioVersion[]; evidence: TeamEvidence[]; policies: TeamPolicyVersion[]; auditAnchors: TeamAuditAnchor[]; audit: TeamAuditRecord[] };
export type LocalTeamControlPlaneOptions = { path?: string; now?: () => Date; randomTokenBytes?: (size: number) => Buffer };

const READ_PERMISSIONS: TeamScopedPermission[] = ["project.read", "environment.read", "scenario.read", "evidence.read", "policy.read"];
const PUBLISH_PERMISSIONS: TeamScopedPermission[] = ["scenario.publish", "evidence.upload"];
const OWNER_PERMISSIONS: TeamPermission[] = ["member.manage", "project.manage", "environment.manage", "policy.manage", "token.manage", "service_account.manage", "audit.read", "audit.export", "data.delete", "retention.manage", ...READ_PERMISSIONS, ...PUBLISH_PERMISSIONS];
const ADMIN_PERMISSIONS: TeamPermission[] = OWNER_PERMISSIONS.filter((permission) => permission !== "member.manage");
const DEVELOPER_PERMISSIONS: TeamPermission[] = [...READ_PERMISSIONS, ...PUBLISH_PERMISSIONS];
const VIEWER_PERMISSIONS: TeamPermission[] = [...READ_PERMISSIONS];
const SERVICE_ACCOUNT_PERMISSIONS: TeamPermission[] = [...DEVELOPER_PERMISSIONS.filter((permission) => permission !== "policy.read")];
export const TEAM_PERMISSION_MATRIX: Readonly<Record<TeamRole, readonly TeamPermission[]>> = Object.freeze({
  owner: Object.freeze([...OWNER_PERMISSIONS]),
  admin: Object.freeze([...ADMIN_PERMISSIONS]),
  developer: Object.freeze([...DEVELOPER_PERMISSIONS]),
  viewer: Object.freeze([...VIEWER_PERMISSIONS]),
  service_account: Object.freeze([...SERVICE_ACCOUNT_PERMISSIONS])
});

export class TeamControlPlaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamControlPlaneError";
  }
}

export function createLocalTeamControlPlane(options: LocalTeamControlPlaneOptions = {}): LocalTeamControlPlane {
  return new LocalTeamControlPlane(options);
}

export class LocalTeamControlPlane {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly randomTokenBytes: (size: number) => Buffer;

  constructor(options: LocalTeamControlPlaneOptions = {}) {
    this.path = options.path ?? getDataPaths().teamControlPlane;
    this.now = options.now ?? (() => new Date());
    this.randomTokenBytes = options.randomTokenBytes ?? randomBytes;
  }

  async bootstrapOrganization(input: { organizationId: string; name: string; ownerId: string }): Promise<TeamOrganization> {
    const organizationId = identifier(input.organizationId, "Organization id");
    const ownerId = identifier(input.ownerId, "Owner id");
    const name = text(input.name, "Organization name", 120);
    return this.mutate((state, now) => {
      if (state.organizations.some((organization) => organization.id === organizationId)) throw new TeamControlPlaneError("Organization already exists.");
      const organization = { id: organizationId, name, createdAt: now };
      state.organizations.push(organization);
      state.members.push({ id: ownerId, organizationId, role: "owner", createdAt: now });
      state.auditAnchors.push({ organizationId, sequence: 0, hash: auditGenesisHash(organizationId) });
      appendAudit(state, organizationId, ownerId, "organization.bootstrap", organizationId, now);
      return organization;
    });
  }

  async addMember(actor: TeamActor, input: { memberId: string; role: Exclude<TeamRole, "owner" | "service_account"> }): Promise<TeamMember> {
    const memberId = identifier(input.memberId, "Member id");
    if (input.role !== "admin" && input.role !== "developer" && input.role !== "viewer") throw new TeamControlPlaneError("Member role is invalid.");
    return this.mutate((state, now) => {
      requirePermission(state, actor, "member.manage");
      if (state.members.some((member) => member.organizationId === actor.organizationId && member.id === memberId)) throw new TeamControlPlaneError("Member already exists.");
      const member = { id: memberId, organizationId: actor.organizationId, role: input.role, createdAt: now };
      state.members.push(member);
      appendAudit(state, actor.organizationId, actorId(actor), "member.add", memberId, now);
      return member;
    });
  }

  async createServiceAccount(actor: TeamActor, input: { serviceAccountId: string; name: string }): Promise<TeamServiceAccount> {
    const serviceAccountId = identifier(input.serviceAccountId, "Service account id");
    const name = text(input.name, "Service account name", 120);
    return this.mutate((state, now) => {
      requirePermission(state, actor, "service_account.manage");
      if (state.serviceAccounts.some((account) => account.organizationId === actor.organizationId && account.id === serviceAccountId)) throw new TeamControlPlaneError("Service account already exists.");
      const account = { id: serviceAccountId, organizationId: actor.organizationId, name, createdBy: actorId(actor), createdAt: now };
      state.serviceAccounts.push(account);
      appendAudit(state, actor.organizationId, actorId(actor), "service_account.create", serviceAccountId, now);
      return account;
    });
  }

  async disableServiceAccount(actor: TeamActor, serviceAccountId: string): Promise<void> {
    const id = identifier(serviceAccountId, "Service account id");
    await this.mutate((state, now) => {
      requirePermission(state, actor, "service_account.manage");
      const account = state.serviceAccounts.find((candidate) => candidate.organizationId === actor.organizationId && candidate.id === id);
      if (account === undefined) throw new TeamControlPlaneError("Resource not found.");
      if (account.disabledAt === undefined) {
        account.disabledAt = now;
        for (const token of state.tokens) {
          if (token.organizationId === actor.organizationId && token.type === "service" && token.subjectId === id && token.revokedAt === undefined) token.revokedAt = now;
        }
        appendAudit(state, actor.organizationId, actorId(actor), "service_account.disable", id, now);
      }
    });
  }

  async registerProject(actor: TeamActor, input: { projectId: string; name: string }): Promise<TeamProject> {
    const projectId = identifier(input.projectId, "Project id");
    const name = text(input.name, "Project name", 120);
    return this.mutate((state, now) => {
      requirePermission(state, actor, "project.manage");
      if (state.projects.some((project) => project.organizationId === actor.organizationId && project.id === projectId)) throw new TeamControlPlaneError("Project already exists.");
      const project = { id: projectId, organizationId: actor.organizationId, name, createdAt: now };
      state.projects.push(project);
      appendAudit(state, actor.organizationId, actorId(actor), "project.register", projectId, now);
      return project;
    });
  }

  async createEnvironment(actor: TeamActor, input: { environmentId: string; projectId: string; name: string; kind: TeamEnvironmentKind }): Promise<TeamEnvironment> {
    const environmentId = identifier(input.environmentId, "Environment id");
    const projectId = identifier(input.projectId, "Project id");
    const name = text(input.name, "Environment name", 80);
    if (input.kind !== "development" && input.kind !== "ci") throw new TeamControlPlaneError("Environment kind is invalid.");
    return this.mutate((state, now) => {
      requirePermission(state, actor, "environment.manage");
      requireProject(state, actor.organizationId, projectId);
      if (state.environments.some((environment) => environment.organizationId === actor.organizationId && environment.projectId === projectId && environment.id === environmentId)) throw new TeamControlPlaneError("Environment already exists.");
      const environment = { id: environmentId, organizationId: actor.organizationId, projectId, name, kind: input.kind, createdAt: now };
      state.environments.push(environment);
      appendAudit(state, actor.organizationId, actorId(actor), "environment.create", environmentId, now);
      return environment;
    });
  }

  async issueToken(actor: TeamActor, input: { memberId?: string; expiresAt: string }): Promise<{ tokenId: string; token: string; expiresAt: string }> {
    const expiresAt = futureTimestamp(input.expiresAt, this.now());
    return this.mutate((state, now) => {
      requirePermission(state, actor, "token.manage");
      const memberId = input.memberId === undefined ? userActorId(actor) : identifier(input.memberId, "Token member id");
      const subject = requireMember(state, { organizationId: actor.organizationId, memberId });
      if (!canManageMemberToken(actorRole(state, actor), subject.role)) throw new TeamControlPlaneError("Access denied.");
      const issued = issueTokenRecord(state, { organizationId: actor.organizationId, type: "user", subjectId: memberId, issuedBy: actorId(actor), expiresAt }, now, this.randomTokenBytes);
      appendAudit(state, actor.organizationId, actorId(actor), "token.issue", issued.tokenId, now);
      return issued;
    });
  }

  async issueServiceToken(actor: TeamActor, input: { serviceAccountId: string; expiresAt: string; scope: TeamTokenScope[] }): Promise<{ tokenId: string; token: string; expiresAt: string }> {
    const serviceAccountId = identifier(input.serviceAccountId, "Service account id");
    const expiresAt = futureTimestamp(input.expiresAt, this.now());
    return this.mutate((state, now) => {
      requirePermission(state, actor, "token.manage");
      requireServiceAccount(state, actor.organizationId, serviceAccountId);
      const scope = validateTokenScope(input.scope, state, actor.organizationId);
      const issued = issueTokenRecord(state, { organizationId: actor.organizationId, type: "service", subjectId: serviceAccountId, issuedBy: actorId(actor), expiresAt, scope }, now, this.randomTokenBytes);
      appendAudit(state, actor.organizationId, actorId(actor), "token.issue_service", issued.tokenId, now);
      return issued;
    });
  }

  async rotateToken(actor: TeamActor, tokenId: string, input: { expiresAt?: string } = {}): Promise<{ tokenId: string; token: string; expiresAt: string }> {
    const id = identifier(tokenId, "Token id");
    return this.mutate((state, now) => {
      requirePermission(state, actor, "token.manage");
      const oldToken = state.tokens.find((candidate) => candidate.id === id && candidate.organizationId === actor.organizationId);
      if (oldToken === undefined) throw new TeamControlPlaneError("Resource not found.");
      if (oldToken.revokedAt !== undefined) throw new TeamControlPlaneError("Token is already revoked.");
      if (oldToken.type === "user" && !canManageMemberToken(actorRole(state, actor), requireMember(state, { organizationId: actor.organizationId, memberId: oldToken.subjectId }).role)) throw new TeamControlPlaneError("Access denied.");
      const expiresAt = input.expiresAt === undefined ? oldToken.expiresAt : futureTimestamp(input.expiresAt, this.now());
      if (new Date(expiresAt).getTime() <= new Date(now).getTime()) throw new TeamControlPlaneError("Token expiry must be within the next 90 days.");
      oldToken.revokedAt = now;
      const issued = issueTokenRecord(state, { organizationId: oldToken.organizationId, type: oldToken.type, subjectId: oldToken.subjectId, issuedBy: actorId(actor), expiresAt, ...(oldToken.scope === undefined ? {} : { scope: oldToken.scope }) }, now, this.randomTokenBytes);
      appendAudit(state, actor.organizationId, actorId(actor), "token.rotate", `${id}->${issued.tokenId}`, now);
      return issued;
    });
  }

  async revokeToken(actor: TeamActor, tokenId: string): Promise<void> {
    const id = identifier(tokenId, "Token id");
    await this.mutate((state, now) => {
      requirePermission(state, actor, "token.manage");
      const token = state.tokens.find((candidate) => candidate.id === id && candidate.organizationId === actor.organizationId);
      if (token === undefined) throw new TeamControlPlaneError("Resource not found.");
      if (token.type === "user" && !canManageMemberToken(actorRole(state, actor), requireMember(state, { organizationId: actor.organizationId, memberId: token.subjectId }).role)) throw new TeamControlPlaneError("Access denied.");
      if (token.revokedAt === undefined) token.revokedAt = now;
      appendAudit(state, actor.organizationId, actorId(actor), "token.revoke", id, now);
    });
  }

  async authenticateToken(token: string): Promise<TeamActor> {
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 256) throw new TeamControlPlaneError("Invalid or expired token.");
    const state = await this.read();
    const digest = hash(token);
    const record = state.tokens.find((candidate) => equalHash(candidate.digest, digest));
    if (record === undefined || record.revokedAt !== undefined || new Date(record.expiresAt).getTime() <= this.now().getTime()) throw new TeamControlPlaneError("Invalid or expired token.");
    if (record.type === "user") {
      requireMember(state, { organizationId: record.organizationId, memberId: record.subjectId });
      return { organizationId: record.organizationId, memberId: record.subjectId };
    }
    if (!state.serviceAccounts.some((account) => account.organizationId === record.organizationId && account.id === record.subjectId && account.disabledAt === undefined)) throw new TeamControlPlaneError("Invalid or expired token.");
    validateTokenScope(record.scope, state, record.organizationId);
    const actor: TeamActor = { organizationId: record.organizationId, serviceAccountId: record.subjectId, actorType: "service_account", tokenId: record.id };
    authenticatedServiceActors.set(actor, this.now);
    return actor;
  }

  async publishScenario(actor: TeamActor, input: { projectId: string; environmentId: string; scenarioId: string; version: number; title: string; metadata: Record<string, unknown> }): Promise<TeamScenarioVersion> {
    const projectId = identifier(input.projectId, "Project id");
    const environmentId = identifier(input.environmentId, "Environment id");
    const scenarioId = identifier(input.scenarioId, "Scenario id");
    const version = positiveInteger(input.version, "Scenario version");
    const title = text(input.title, "Scenario title", 160);
    const metadata = safeJson(input.metadata, "Scenario metadata", 16 * 1024) as Record<string, unknown>;
    return this.mutate((state, now) => {
      requireScopedPermission(state, actor, "scenario.publish", projectId, environmentId);
      requireProject(state, actor.organizationId, projectId);
      requireEnvironment(state, actor.organizationId, projectId, environmentId);
      if (state.scenarios.some((scenario) => scenario.organizationId === actor.organizationId && scenario.projectId === projectId && scenario.environmentId === environmentId && scenario.scenarioId === scenarioId && scenario.version === version)) throw new TeamControlPlaneError("Scenario version already exists.");
      const scenario = { organizationId: actor.organizationId, projectId, environmentId, scenarioId, version, title, metadata, createdBy: actorId(actor), createdAt: now };
      state.scenarios.push(scenario);
      appendAudit(state, actor.organizationId, actorId(actor), "scenario.publish", `${scenarioId}@${version}`, now);
      return scenario;
    });
  }

  async uploadSanitizedEvidence(actor: TeamActor, input: { evidenceId: string; projectId: string; environmentId: string; report: unknown }): Promise<TeamEvidence> {
    const evidenceId = identifier(input.evidenceId, "Evidence id");
    const projectId = identifier(input.projectId, "Project id");
    const environmentId = identifier(input.environmentId, "Environment id");
    const report = validateEvidenceReport(input.report);
    rejectRawEvidence(report);
    return this.mutate((state, now) => {
      requireScopedPermission(state, actor, "evidence.upload", projectId, environmentId);
      requireProject(state, actor.organizationId, projectId);
      requireEnvironment(state, actor.organizationId, projectId, environmentId);
      if (state.evidence.some((evidence) => evidence.organizationId === actor.organizationId && evidence.id === evidenceId)) throw new TeamControlPlaneError("Evidence already exists.");
      const evidence: TeamEvidence = {
        id: evidenceId, organizationId: actor.organizationId, projectId, environmentId, runId: runId(report.run.id), evidenceHash: report.artifact.logicalHash, status: report.run.status,
        passed: report.summary.passed, failCount: report.summary.failCount, warningCount: report.summary.warningCount, providers: list(report.coverage.providers, "Evidence providers"), scenarios: list(report.coverage.scenarios, "Evidence scenarios", true),
        enforcement: { mode: report.enforcement.mode, isolated: report.enforcement.isolated, degraded: report.enforcement.degraded }, uploadedBy: actorId(actor), uploadedAt: now, expiresAt: addDays(now, EVIDENCE_RETENTION_DAYS)
      };
      state.evidence.push(evidence);
      appendAudit(state, actor.organizationId, actorId(actor), "evidence.upload", evidenceId, now);
      return evidence;
    });
  }

  async deleteEvidence(actor: TeamActor, input: { projectId: string; evidenceId: string }): Promise<void> {
    const projectId = identifier(input.projectId, "Project id");
    const evidenceId = identifier(input.evidenceId, "Evidence id");
    await this.mutate((state, now) => {
      requirePermission(state, actor, "data.delete");
      requireProject(state, actor.organizationId, projectId);
      const index = state.evidence.findIndex((evidence) => evidence.organizationId === actor.organizationId && evidence.projectId === projectId && evidence.id === evidenceId);
      if (index === -1) throw new TeamControlPlaneError("Resource not found.");
      state.evidence.splice(index, 1);
      appendAudit(state, actor.organizationId, actorId(actor), "evidence.delete", evidenceId, now);
    });
  }

  async distributePolicy(actor: TeamActor, input: { version: number; policy: GhostApiPolicy }): Promise<TeamPolicyVersion> {
    const version = positiveInteger(input.version, "Policy version");
    const policy = safeJson(input.policy, "Team policy", 32 * 1024) as GhostApiPolicy;
    validatePolicy(policy);
    return this.mutate((state, now) => {
      requirePermission(state, actor, "policy.manage");
      if (state.policies.some((candidate) => candidate.organizationId === actor.organizationId && candidate.version === version)) throw new TeamControlPlaneError("Policy version already exists.");
      const distributed = { organizationId: actor.organizationId, version, policy, hash: stableHash(policy), distributedBy: actorId(actor), distributedAt: now };
      state.policies.push(distributed);
      appendAudit(state, actor.organizationId, actorId(actor), "policy.distribute", `policy@${version}`, now);
      return distributed;
    });
  }

  async listProjects(actor: TeamActor): Promise<TeamProject[]> {
    const state = await this.read();
    requirePermission(state, actor, "project.read");
    return state.projects.filter((project) => project.organizationId === actor.organizationId && (!isServiceActor(actor) || serviceTokenScopes(state, actor).some((scope) => scope.projectId === project.id && scope.permissions.includes("project.read")))).map((project) => structuredClone(project));
  }

  async listEvidence(actor: TeamActor, projectId: string): Promise<TeamEvidence[]> {
    const id = identifier(projectId, "Project id");
    const state = await this.read();
    if (isServiceActor(actor)) {
      if (!serviceTokenScopes(state, actor).some((scope) => scope.projectId === id && scope.permissions.includes("evidence.read"))) throw new TeamControlPlaneError("Access denied.");
    } else {
      requirePermission(state, actor, "evidence.read");
    }
    requireProject(state, actor.organizationId, id);
    return state.evidence.filter((evidence) => evidence.organizationId === actor.organizationId && evidence.projectId === id && canReadEvidence(state, actor, evidence)).map((evidence) => structuredClone(evidence));
  }

  async listScenarioVersions(actor: TeamActor, input: { projectId: string; environmentId: string; scenarioId: string }): Promise<TeamScenarioVersion[]> {
    const projectId = identifier(input.projectId, "Project id");
    const environmentId = identifier(input.environmentId, "Environment id");
    const scenarioId = identifier(input.scenarioId, "Scenario id");
    const state = await this.read();
    requireScopedPermission(state, actor, "scenario.read", projectId, environmentId);
    requireEnvironment(state, actor.organizationId, projectId, environmentId);
    return state.scenarios.filter((scenario) => scenario.organizationId === actor.organizationId && scenario.projectId === projectId && scenario.environmentId === environmentId && scenario.scenarioId === scenarioId).sort((left, right) => left.version - right.version).map((scenario) => structuredClone(scenario));
  }

  async getLatestPolicy(actor: TeamActor): Promise<TeamPolicyVersion | null> {
    const state = await this.read();
    requirePermission(state, actor, "policy.read");
    const policy = state.policies.filter((candidate) => candidate.organizationId === actor.organizationId).sort((left, right) => right.version - left.version)[0];
    return policy === undefined ? null : structuredClone(policy);
  }

  async listAudit(actor: TeamActor): Promise<TeamAuditRecord[]> {
    const state = await this.read();
    requirePermission(state, actor, "audit.read");
    return state.audit.filter((record) => record.organizationId === actor.organizationId).map((record) => structuredClone(record));
  }

  async exportAudit(actor: TeamActor): Promise<TeamAuditExport> {
    const state = await this.read();
    requirePermission(state, actor, "audit.export");
    const anchor = state.auditAnchors.find((candidate) => candidate.organizationId === actor.organizationId);
    if (anchor === undefined) throw new TeamControlPlaneError("Resource not found.");
    const records = state.audit.filter((record) => record.organizationId === actor.organizationId).map((record) => structuredClone(record));
    return { organizationId: actor.organizationId, anchor: structuredClone(anchor), records, integrity: verifyAuditChain(actor.organizationId, anchor, records) };
  }

  async pruneRetention(actor: TeamActor): Promise<{ evidenceRemoved: number; auditRemoved: number }> {
    return this.mutate((state, now) => {
      requirePermission(state, actor, "retention.manage");
      const beforeEvidence = state.evidence.length;
      const beforeAudit = state.audit.length;
      retain(state, now);
      const auditRemoved = beforeAudit - state.audit.length;
      appendAudit(state, actor.organizationId, actorId(actor), "retention.prune", "team-control-plane", now);
      retain(state, now);
      return { evidenceRemoved: beforeEvidence - state.evidence.length, auditRemoved };
    }, false);
  }

  async deleteProject(actor: TeamActor, projectId: string): Promise<void> {
    const id = identifier(projectId, "Project id");
    await this.mutate((state, now) => {
      requirePermission(state, actor, "data.delete");
      requireProject(state, actor.organizationId, id);
      state.projects = state.projects.filter((project) => !(project.organizationId === actor.organizationId && project.id === id));
      state.environments = state.environments.filter((environment) => !(environment.organizationId === actor.organizationId && environment.projectId === id));
      state.scenarios = state.scenarios.filter((scenario) => !(scenario.organizationId === actor.organizationId && scenario.projectId === id));
      state.evidence = state.evidence.filter((evidence) => !(evidence.organizationId === actor.organizationId && evidence.projectId === id));
      state.tokens = state.tokens.filter((token) => !(token.organizationId === actor.organizationId && token.type === "service" && token.scope?.some((scope) => scope.projectId === id)));
      appendAudit(state, actor.organizationId, actorId(actor), "project.delete", id, now);
    });
  }

  async readStateForTesting(): Promise<TeamControlPlaneState> {
    return this.read();
  }

  private async read(): Promise<TeamControlPlaneState> {
    await ensurePrivateDirectory(dirname(this.path));
    const info = await lstat(this.path).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
    if (info === null) return emptyState();
    if (!info.isFile() || info.isSymbolicLink()) throw new TeamControlPlaneError("Team control-plane store must be a regular non-symlink file.");
    const source = await readFile(this.path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_STORE_BYTES) throw new TeamControlPlaneError(`Team control-plane store exceeds ${MAX_STORE_BYTES} bytes.`);
    try {
      const state = migrateTeamControlPlane(JSON.parse(source));
      for (const organization of state.organizations) {
        const anchor = state.auditAnchors.find((candidate) => candidate.organizationId === organization.id);
        if (anchor === undefined || !verifyAuditChain(organization.id, anchor, state.audit.filter((record) => record.organizationId === organization.id)).valid) throw new TeamControlPlaneError("Audit integrity verification failed.");
      }
      return state;
    } catch (error) {
      if (error instanceof TeamControlPlaneError) throw error;
      throw new TeamControlPlaneError("Team control-plane store is not valid JSON.");
    }
  }

  private async mutate<T>(operation: (state: TeamControlPlaneState, now: string) => T, autoRetain = true): Promise<T> {
    return withFileLock(this.path, async () => {
      const state = await this.read();
      const now = this.now().toISOString();
      const result = operation(state, now);
      if (autoRetain) retain(state, now);
      await atomicWriteJson(this.path, validateState(state));
      return result;
    });
  }
}

export function verifyAuditExport(value: unknown): { valid: boolean; reason?: string } {
  try {
    const exportValue = object(value, "Audit export is invalid.");
    exactKeys(exportValue, ["organizationId", "anchor", "records", "integrity"], "Audit export");
    const organizationId = identifier(exportValue.organizationId, "Audit export organization id");
    const anchor = auditAnchor(exportValue.anchor, new Set([organizationId]));
    const records = array(exportValue.records, "Audit export records", MAX_AUDIT_PER_ORGANIZATION).map((record) => auditRecord(record, new Set([organizationId]), [], []));
    return verifyAuditChain(organizationId, anchor, records);
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : "Audit export is invalid." };
  }
}

export function migrateTeamControlPlane(value: unknown): TeamControlPlaneState {
  const state = object(value, "Team control-plane store must be an object.");
  if (state.schemaVersion === 1) {
    exactKeys(state, ["schemaVersion", "organizations", "members", "projects", "environments", "tokens", "scenarios", "evidence", "policies"], "Team control-plane v1 store");
    return migrateV2State({ ...state, schemaVersion: 2, audit: [] });
  }
  if (state.schemaVersion === 2) return migrateV2State(state);
  return validateState(state);
}

function migrateV2State(value: Record<string, unknown>): TeamControlPlaneState {
  exactKeys(value, ["schemaVersion", "organizations", "members", "projects", "environments", "tokens", "scenarios", "evidence", "policies", "audit"], "Team control-plane v2 store");
  if (value.schemaVersion !== 2) throw new TeamControlPlaneError("Unsupported team control-plane schema version.");
  const members = array(value.members, "Members", 1_000).map((raw) => {
    const entry = object(raw, "Member is invalid.");
    exactKeys(entry, ["id", "organizationId", "role", "createdAt"], "Member");
    if (entry.role !== "owner" && entry.role !== "admin" && entry.role !== "member") throw new TeamControlPlaneError("Member is invalid.");
    return { ...entry, role: entry.role === "member" ? "developer" : entry.role };
  });
  const tokens = array(value.tokens, "Tokens", 10_000).map((raw) => {
    const entry = object(raw, "Token is invalid.");
    exactKeys(entry, ["id", "organizationId", "memberId", "digest", "issuedBy", "issuedAt", "expiresAt", "revokedAt"], "Token", ["revokedAt"]);
    const { memberId, ...rest } = entry;
    return { ...rest, type: "user", subjectId: memberId };
  });
  const base = {
    schemaVersion: 3 as const,
    organizations: value.organizations,
    members,
    serviceAccounts: [],
    projects: value.projects,
    environments: value.environments,
    tokens,
    scenarios: value.scenarios,
    evidence: value.evidence,
    policies: value.policies,
    auditAnchors: [],
    audit: []
  };
  const validatedBase = validateState({ ...base, auditAnchors: array(value.organizations, "Organizations", 100).map((raw) => ({ organizationId: identifier(object(raw, "Organization is invalid.").id, "Organization id"), sequence: 0, hash: auditGenesisHash(identifier(object(raw, "Organization is invalid.").id, "Organization id")) })) });
  const legacyAudit = array(value.audit, "Audit records", 100_000).map((raw) => legacyAuditRecord(raw, new Set(validatedBase.organizations.map((organization) => organization.id)), validatedBase.members));
  for (const record of legacyAudit) appendAudit(validatedBase, record.organizationId, record.actorId, record.action, record.resource, record.timestamp);
  return validateState(validatedBase);
}

function emptyState(): TeamControlPlaneState {
  return { schemaVersion: 3, organizations: [], members: [], serviceAccounts: [], projects: [], environments: [], tokens: [], scenarios: [], evidence: [], policies: [], auditAnchors: [], audit: [] };
}

function validateState(value: unknown): TeamControlPlaneState {
  const state = object(value, "Team control-plane store must be an object.");
  exactKeys(state, ["schemaVersion", "organizations", "members", "serviceAccounts", "projects", "environments", "tokens", "scenarios", "evidence", "policies", "auditAnchors", "audit"], "Team control-plane store");
  if (state.schemaVersion !== SCHEMA_VERSION) throw new TeamControlPlaneError("Unsupported team control-plane schema version.");
  const organizations = array(state.organizations, "Organizations", 100).map((entry) => {
    const organization = object(entry, "Organization is invalid."); exactKeys(organization, ["id", "name", "createdAt"], "Organization");
    return { id: identifier(organization.id, "Organization id"), name: text(organization.name, "Organization name", 120), createdAt: timestamp(organization.createdAt, "Organization createdAt") };
  });
  unique(organizations.map((entry) => entry.id), "Organization ids");
  const organizationIds = new Set(organizations.map((entry) => entry.id));
  const members = array(state.members, "Members", 1_000).map((entry) => member(entry, organizationIds));
  unique(members.map((entry) => scopedKey(entry.organizationId, entry.id)), "Organization member ids");
  for (const organization of organizations) if (!members.some((candidate) => candidate.organizationId === organization.id && candidate.role === "owner")) throw new TeamControlPlaneError("Each organization requires an owner.");
  const serviceAccounts = array(state.serviceAccounts, "Service accounts", 1_000).map((entry) => serviceAccount(entry, organizationIds, members));
  unique(serviceAccounts.map((entry) => scopedKey(entry.organizationId, entry.id)), "Organization service account ids");
  const actorIds = actorReferenceIds(members, serviceAccounts);
  const projects = array(state.projects, "Projects", 1_000).map((entry) => project(entry, organizationIds));
  unique(projects.map((entry) => scopedKey(entry.organizationId, entry.id)), "Organization project ids");
  const projectOwners = new Set(projects.map((entry) => scopedKey(entry.organizationId, entry.id)));
  const environments = array(state.environments, "Environments", 2_000).map((entry) => environment(entry, organizationIds, projectOwners));
  unique(environments.map((entry) => scopedKey(entry.organizationId, entry.projectId, entry.id)), "Project environment ids");
  const environmentsById = new Map(environments.map((entry) => [scopedKey(entry.organizationId, entry.projectId, entry.id), entry]));
  const tokens = array(state.tokens, "Tokens", 10_000).map((entry) => token(entry, organizationIds, members, serviceAccounts, projects, environments));
  unique(tokens.map((entry) => entry.id), "Token ids");
  const scenarios = array(state.scenarios, "Scenarios", 10_000).map((entry) => scenario(entry, organizationIds, projectOwners, environmentsById, actorIds));
  unique(scenarios.map((entry) => scopedKey(entry.organizationId, entry.projectId, entry.environmentId, entry.scenarioId, String(entry.version))), "Scenario versions");
  const evidence = array(state.evidence, "Evidence", 10_000).map((entry) => evidenceRecord(entry, organizationIds, projectOwners, environmentsById, actorIds));
  unique(evidence.map((entry) => scopedKey(entry.organizationId, entry.id)), "Organization evidence ids");
  const policies = array(state.policies, "Policies", 10_000).map((entry) => policyVersion(entry, organizationIds, actorIds));
  unique(policies.map((entry) => scopedKey(entry.organizationId, String(entry.version))), "Policy versions");
  const auditAnchors = array(state.auditAnchors, "Audit anchors", 100).map((entry) => auditAnchor(entry, organizationIds));
  unique(auditAnchors.map((entry) => entry.organizationId), "Audit anchor organization ids");
  if (auditAnchors.length !== organizations.length || auditAnchors.some((anchor) => !organizationIds.has(anchor.organizationId))) throw new TeamControlPlaneError("Each organization requires an audit anchor.");
  const auditRecords = array(state.audit, "Audit records", 100_000).map((entry) => auditRecord(entry, organizationIds, members, serviceAccounts));
  for (const organization of organizations) {
    const anchor = auditAnchors.find((candidate) => candidate.organizationId === organization.id);
    if (anchor === undefined || !verifyAuditChain(organization.id, anchor, auditRecords.filter((record) => record.organizationId === organization.id)).valid) throw new TeamControlPlaneError("Audit chain is invalid.");
  }
  return { schemaVersion: 3, organizations, members, serviceAccounts, projects, environments, tokens, scenarios, evidence, policies, auditAnchors, audit: auditRecords };
}

function member(value: unknown, organizations: Set<string>): TeamMember {
  const entry = object(value, "Member is invalid."); exactKeys(entry, ["id", "organizationId", "role", "createdAt"], "Member");
  const organizationId = identifier(entry.organizationId, "Member organization id");
  if (!organizations.has(organizationId) || (entry.role !== "owner" && entry.role !== "admin" && entry.role !== "developer" && entry.role !== "viewer")) throw new TeamControlPlaneError("Member is invalid.");
  return { id: identifier(entry.id, "Member id"), organizationId, role: entry.role, createdAt: timestamp(entry.createdAt, "Member createdAt") };
}

function serviceAccount(value: unknown, organizations: Set<string>, members: TeamMember[]): TeamServiceAccount {
  const entry = object(value, "Service account is invalid."); exactKeys(entry, ["id", "organizationId", "name", "createdBy", "createdAt", "disabledAt"], "Service account", ["disabledAt"]);
  const organizationId = identifier(entry.organizationId, "Service account organization id");
  if (!organizations.has(organizationId) || !members.some((member) => member.organizationId === organizationId && member.id === entry.createdBy)) throw new TeamControlPlaneError("Service account is invalid.");
  return { id: identifier(entry.id, "Service account id"), organizationId, name: text(entry.name, "Service account name", 120), createdBy: identifier(entry.createdBy, "Service account creator id"), createdAt: timestamp(entry.createdAt, "Service account createdAt"), ...(entry.disabledAt === undefined ? {} : { disabledAt: timestamp(entry.disabledAt, "Service account disabledAt") }) };
}

function project(value: unknown, organizations: Set<string>): TeamProject {
  const entry = object(value, "Project is invalid."); exactKeys(entry, ["id", "organizationId", "name", "createdAt"], "Project");
  const organizationId = identifier(entry.organizationId, "Project organization id"); if (!organizations.has(organizationId)) throw new TeamControlPlaneError("Project organization is invalid.");
  return { id: identifier(entry.id, "Project id"), organizationId, name: text(entry.name, "Project name", 120), createdAt: timestamp(entry.createdAt, "Project createdAt") };
}

function environment(value: unknown, organizations: Set<string>, projects: Set<string>): TeamEnvironment {
  const entry = object(value, "Environment is invalid."); exactKeys(entry, ["id", "organizationId", "projectId", "name", "kind", "createdAt"], "Environment");
  const organizationId = identifier(entry.organizationId, "Environment organization id"); const projectId = identifier(entry.projectId, "Environment project id");
  if (!organizations.has(organizationId) || !projects.has(scopedKey(organizationId, projectId)) || (entry.kind !== "development" && entry.kind !== "ci")) throw new TeamControlPlaneError("Environment is invalid.");
  return { id: identifier(entry.id, "Environment id"), organizationId, projectId, name: text(entry.name, "Environment name", 80), kind: entry.kind, createdAt: timestamp(entry.createdAt, "Environment createdAt") };
}

function token(value: unknown, organizations: Set<string>, members: TeamMember[], serviceAccounts: TeamServiceAccount[], projects: TeamProject[], environments: TeamEnvironment[]): TeamToken {
  const entry = object(value, "Token is invalid."); exactKeys(entry, ["id", "organizationId", "type", "subjectId", "digest", "issuedBy", "issuedAt", "expiresAt", "scope", "revokedAt"], "Token", ["scope", "revokedAt"]);
  const organizationId = identifier(entry.organizationId, "Token organization id"); const subjectId = identifier(entry.subjectId, "Token subject id");
  if (!organizations.has(organizationId) || (entry.type !== "user" && entry.type !== "service") || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest)) throw new TeamControlPlaneError("Token is invalid.");
  if (entry.type === "user" && !members.some((member) => member.organizationId === organizationId && member.id === subjectId)) throw new TeamControlPlaneError("Token is invalid.");
  const serviceAccount = entry.type === "service" ? serviceAccounts.find((account) => account.organizationId === organizationId && account.id === subjectId) : undefined;
  if (entry.type === "service" && serviceAccount === undefined) throw new TeamControlPlaneError("Token is invalid.");
  const scope = entry.type === "service" ? validateTokenScope(entry.scope, { projects, environments }, organizationId) : undefined;
  if (entry.type === "user" && entry.scope !== undefined) throw new TeamControlPlaneError("Token is invalid.");
  if (!actorReferenceExists(organizationId, entry.issuedBy, members, serviceAccounts)) throw new TeamControlPlaneError("Token is invalid.");
  const issuedAt = timestamp(entry.issuedAt, "Token issuedAt");
  const expiresAt = timestamp(entry.expiresAt, "Token expiresAt");
  if (new Date(expiresAt).getTime() > new Date(issuedAt).getTime() + 90 * 24 * 60 * 60 * 1000) throw new TeamControlPlaneError("Token is invalid.");
  const revokedAt = entry.revokedAt === undefined ? undefined : timestamp(entry.revokedAt, "Token revokedAt");
  if (entry.type === "service" && serviceAccount?.disabledAt !== undefined && revokedAt === undefined) throw new TeamControlPlaneError("Token is invalid.");
  return { id: identifier(entry.id, "Token id"), organizationId, type: entry.type, subjectId, digest: entry.digest, issuedBy: actorReference(entry.issuedBy, "Token issuer id"), issuedAt, expiresAt, ...(scope === undefined ? {} : { scope }), ...(revokedAt === undefined ? {} : { revokedAt }) };
}

function scenario(value: unknown, organizations: Set<string>, projects: Set<string>, environments: Map<string, TeamEnvironment>, actors: Set<string>): TeamScenarioVersion {
  const entry = object(value, "Scenario is invalid."); exactKeys(entry, ["organizationId", "projectId", "environmentId", "scenarioId", "version", "title", "metadata", "createdBy", "createdAt"], "Scenario");
  const organizationId = identifier(entry.organizationId, "Scenario organization id"); const projectId = identifier(entry.projectId, "Scenario project id"); const environmentId = identifier(entry.environmentId, "Scenario environment id");
  if (!organizations.has(organizationId) || !projects.has(scopedKey(organizationId, projectId)) || environments.get(scopedKey(organizationId, projectId, environmentId)) === undefined || !actors.has(scopedKey(organizationId, actorReference(entry.createdBy, "Scenario creator id")))) throw new TeamControlPlaneError("Scenario is invalid.");
  return { organizationId, projectId, environmentId, scenarioId: identifier(entry.scenarioId, "Scenario id"), version: positiveInteger(entry.version, "Scenario version"), title: text(entry.title, "Scenario title", 160), metadata: safeJson(entry.metadata, "Scenario metadata", 16 * 1024) as Record<string, unknown>, createdBy: actorReference(entry.createdBy, "Scenario creator id"), createdAt: timestamp(entry.createdAt, "Scenario createdAt") };
}

function evidenceRecord(value: unknown, organizations: Set<string>, projects: Set<string>, environments: Map<string, TeamEnvironment>, actors: Set<string>): TeamEvidence {
  const entry = object(value, "Evidence is invalid."); exactKeys(entry, ["id", "organizationId", "projectId", "environmentId", "runId", "evidenceHash", "status", "passed", "failCount", "warningCount", "providers", "scenarios", "enforcement", "uploadedBy", "uploadedAt", "expiresAt"], "Evidence");
  const organizationId = identifier(entry.organizationId, "Evidence organization id"); const projectId = identifier(entry.projectId, "Evidence project id"); const environmentId = identifier(entry.environmentId, "Evidence environment id"); const enforcement = object(entry.enforcement, "Evidence enforcement is invalid."); exactKeys(enforcement, ["mode", "isolated", "degraded"], "Evidence enforcement");
  if (!organizations.has(organizationId) || !projects.has(scopedKey(organizationId, projectId)) || environments.get(scopedKey(organizationId, projectId, environmentId)) === undefined || !actors.has(scopedKey(organizationId, actorReference(entry.uploadedBy, "Evidence uploader id"))) || typeof entry.evidenceHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.evidenceHash) || !runStatus(entry.status) || typeof entry.passed !== "boolean" || !nonNegativeInteger(entry.failCount) || !nonNegativeInteger(entry.warningCount) || !evidenceMode(enforcement.mode) || typeof enforcement.isolated !== "boolean" || typeof enforcement.degraded !== "boolean") throw new TeamControlPlaneError("Evidence is invalid.");
  return { id: identifier(entry.id, "Evidence id"), organizationId, projectId, environmentId, runId: runId(entry.runId), evidenceHash: entry.evidenceHash, status: entry.status, passed: entry.passed, failCount: entry.failCount, warningCount: entry.warningCount, providers: list(entry.providers, "Evidence providers"), scenarios: list(entry.scenarios, "Evidence scenarios", true), enforcement: { mode: enforcement.mode, isolated: enforcement.isolated, degraded: enforcement.degraded }, uploadedBy: actorReference(entry.uploadedBy, "Evidence uploader id"), uploadedAt: timestamp(entry.uploadedAt, "Evidence uploadedAt"), expiresAt: timestamp(entry.expiresAt, "Evidence expiresAt") };
}

function policyVersion(value: unknown, organizations: Set<string>, actors: Set<string>): TeamPolicyVersion {
  const entry = object(value, "Policy is invalid."); exactKeys(entry, ["organizationId", "version", "policy", "hash", "distributedBy", "distributedAt"], "Policy");
  const organizationId = identifier(entry.organizationId, "Policy organization id"); const policy = safeJson(entry.policy, "Team policy", 32 * 1024) as GhostApiPolicy; validatePolicy(policy);
  if (!organizations.has(organizationId) || !actors.has(scopedKey(organizationId, actorReference(entry.distributedBy, "Policy distributor id"))) || typeof entry.hash !== "string" || entry.hash !== stableHash(policy)) throw new TeamControlPlaneError("Policy is invalid.");
  return { organizationId, version: positiveInteger(entry.version, "Policy version"), policy, hash: entry.hash, distributedBy: actorReference(entry.distributedBy, "Policy distributor id"), distributedAt: timestamp(entry.distributedAt, "Policy distributedAt") };
}

function auditAnchor(value: unknown, organizations: Set<string>): TeamAuditAnchor {
  const entry = object(value, "Audit anchor is invalid."); exactKeys(entry, ["organizationId", "sequence", "hash"], "Audit anchor");
  const organizationId = identifier(entry.organizationId, "Audit anchor organization id");
  if (!organizations.has(organizationId) || !nonNegativeInteger(entry.sequence) || typeof entry.hash !== "string" || !/^[a-f0-9]{64}$/.test(entry.hash)) throw new TeamControlPlaneError("Audit anchor is invalid.");
  return { organizationId, sequence: entry.sequence, hash: entry.hash };
}

function auditRecord(value: unknown, organizations: Set<string>, members: TeamMember[], serviceAccounts: TeamServiceAccount[]): TeamAuditRecord {
  const entry = object(value, "Audit record is invalid."); exactKeys(entry, ["organizationId", "sequence", "actorId", "action", "resource", "timestamp", "previousHash", "recordHash"], "Audit record");
  const organizationId = identifier(entry.organizationId, "Audit organization id"); const actorIdValue = actorReference(entry.actorId, "Audit actor id");
  const sequence = positiveInteger(entry.sequence, "Audit sequence");
  if (!organizations.has(organizationId) || ((members.length > 0 || serviceAccounts.length > 0) && !actorReferenceExists(organizationId, actorIdValue, members, serviceAccounts)) || typeof entry.previousHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.previousHash) || typeof entry.recordHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.recordHash)) throw new TeamControlPlaneError("Audit record is invalid.");
  return { organizationId, sequence, actorId: actorIdValue, action: text(entry.action, "Audit action", 80), resource: text(entry.resource, "Audit resource", 160), timestamp: timestamp(entry.timestamp, "Audit timestamp"), previousHash: entry.previousHash, recordHash: entry.recordHash };
}

function legacyAuditRecord(value: unknown, organizations: Set<string>, members: TeamMember[]): { organizationId: string; actorId: string; action: string; resource: string; timestamp: string } {
  const entry = object(value, "Audit record is invalid."); exactKeys(entry, ["organizationId", "actorId", "action", "resource", "timestamp"], "Audit record");
  const organizationId = identifier(entry.organizationId, "Audit organization id"); const actorIdValue = identifier(entry.actorId, "Audit actor id");
  if (!organizations.has(organizationId) || !members.some((member) => member.organizationId === organizationId && member.id === actorIdValue)) throw new TeamControlPlaneError("Audit record is invalid.");
  return { organizationId, actorId: actorIdValue, action: text(entry.action, "Audit action", 80), resource: text(entry.resource, "Audit resource", 160), timestamp: timestamp(entry.timestamp, "Audit timestamp") };
}

function requirePermission(state: TeamControlPlaneState, actor: TeamActor, permission: TeamPermission): void {
  const role = actorRole(state, actor);
  if (!TEAM_PERMISSION_MATRIX[role].includes(permission)) throw new TeamControlPlaneError("Access denied.");
}

function requireScopedPermission(state: TeamControlPlaneState, actor: TeamActor, permission: TeamScopedPermission, projectId: string, environmentId: string): void {
  requirePermission(state, actor, permission);
  if (isServiceActor(actor) && !serviceTokenScopes(state, actor).some((scope) => scope.projectId === projectId && scope.environmentId === environmentId && scope.permissions.includes(permission))) throw new TeamControlPlaneError("Access denied.");
}

const MEMBER_TOKEN_MANAGEMENT_MATRIX: Readonly<Record<Exclude<TeamRole, "service_account">, readonly Exclude<TeamRole, "service_account">[]>> = Object.freeze({
  owner: ["owner", "admin", "developer", "viewer"],
  admin: ["admin", "developer", "viewer"],
  developer: [],
  viewer: []
});

function canManageMemberToken(actor: TeamRole, subject: Exclude<TeamRole, "service_account">): boolean {
  return actor !== "service_account" && MEMBER_TOKEN_MANAGEMENT_MATRIX[actor].includes(subject);
}

function actorRole(state: TeamControlPlaneState, actor: TeamActor): TeamRole {
  const organizationId = identifier(actor.organizationId, "Organization id");
  if (isServiceActor(actor)) {
    if (!authenticatedServiceActors.has(actor)) throw new TeamControlPlaneError("Access denied.");
    const serviceAccountId = identifier(actor.serviceAccountId, "Service account id");
    const account = state.serviceAccounts.find((candidate) => candidate.organizationId === organizationId && candidate.id === serviceAccountId && candidate.disabledAt === undefined);
    if (account === undefined) throw new TeamControlPlaneError("Access denied.");
    serviceTokenScopes(state, actor);
    return "service_account";
  }
  const memberId = identifier(actor.memberId, "Member id");
  const member = state.members.find((candidate) => candidate.organizationId === organizationId && candidate.id === memberId);
  if (member === undefined) throw new TeamControlPlaneError("Access denied.");
  return member.role;
}

function requireMember(state: TeamControlPlaneState, actor: { organizationId: string; memberId: string }): TeamMember {
  const organizationId = identifier(actor.organizationId, "Organization id"); const memberId = identifier(actor.memberId, "Member id");
  const member = state.members.find((candidate) => candidate.organizationId === organizationId && candidate.id === memberId);
  if (member === undefined) throw new TeamControlPlaneError("Access denied.");
  return member;
}

function requireServiceAccount(state: TeamControlPlaneState, organizationId: string, serviceAccountId: string): TeamServiceAccount {
  const account = state.serviceAccounts.find((candidate) => candidate.organizationId === organizationId && candidate.id === serviceAccountId && candidate.disabledAt === undefined);
  if (account === undefined) throw new TeamControlPlaneError("Resource not found.");
  return account;
}

function requireProject(state: TeamControlPlaneState, organizationId: string, projectId: string): void {
  if (!state.projects.some((candidate) => candidate.organizationId === organizationId && candidate.id === projectId)) throw new TeamControlPlaneError("Resource not found.");
}

function requireEnvironment(state: TeamControlPlaneState, organizationId: string, projectId: string, environmentId: string): void {
  if (!state.environments.some((candidate) => candidate.organizationId === organizationId && candidate.projectId === projectId && candidate.id === environmentId)) throw new TeamControlPlaneError("Resource not found.");
}

function issueTokenRecord(state: TeamControlPlaneState, input: { organizationId: string; type: "user" | "service"; subjectId: string; issuedBy: string; expiresAt: string; scope?: TeamTokenScope[] }, issuedAt: string, random: (size: number) => Buffer): { tokenId: string; token: string; expiresAt: string } {
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const tokenId = `tok_${random(8).toString("hex")}`;
    const token = `${TOKEN_PREFIX}${random(32).toString("base64url")}`;
    const digest = hash(token);
    if (state.tokens.some((candidate) => candidate.id === tokenId || equalHash(candidate.digest, digest))) continue;
    state.tokens.push({ id: tokenId, organizationId: input.organizationId, type: input.type, subjectId: input.subjectId, digest, issuedBy: input.issuedBy, issuedAt, expiresAt: input.expiresAt, ...(input.scope === undefined ? {} : { scope: structuredClone(input.scope) }) });
    return { tokenId, token, expiresAt: input.expiresAt };
  }
  throw new TeamControlPlaneError("Unable to allocate a unique token.");
}

function appendAudit(state: TeamControlPlaneState, organizationId: string, actorIdValue: string, action: string, resource: string, timestampValue: string): void {
  const anchor = state.auditAnchors.find((candidate) => candidate.organizationId === organizationId);
  if (anchor === undefined) throw new TeamControlPlaneError("Audit anchor is missing.");
  const records = state.audit.filter((record) => record.organizationId === organizationId);
  const previous = records.at(-1);
  const sequence = previous === undefined ? anchor.sequence + 1 : previous.sequence + 1;
  const previousHash = previous === undefined ? anchor.hash : previous.recordHash;
  const recordWithoutHash = { organizationId, sequence, actorId: actorIdValue, action, resource, timestamp: timestampValue, previousHash };
  state.audit.push({ ...recordWithoutHash, recordHash: stableHash(recordWithoutHash) });
}

function verifyAuditChain(organizationId: string, anchor: TeamAuditAnchor, records: TeamAuditRecord[]): { valid: boolean; reason?: string } {
  try {
    if (anchor.organizationId !== organizationId) return { valid: false, reason: "Audit anchor organization does not match." };
    let expectedSequence = anchor.sequence + 1;
    let previousHash = anchor.hash;
    for (const record of records) {
      if (record.organizationId !== organizationId || record.sequence !== expectedSequence || record.previousHash !== previousHash) return { valid: false, reason: "Audit sequence or previous hash is invalid." };
      const expectedHash = stableHash({ organizationId: record.organizationId, sequence: record.sequence, actorId: record.actorId, action: record.action, resource: record.resource, timestamp: record.timestamp, previousHash: record.previousHash });
      if (!equalHash(record.recordHash, expectedHash)) return { valid: false, reason: "Audit record hash is invalid." };
      expectedSequence += 1;
      previousHash = record.recordHash;
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: "Audit chain is invalid." };
  }
}

function retain(state: TeamControlPlaneState, now: string): void {
  state.evidence = state.evidence.filter((entry) => entry.expiresAt > now);
  for (const organization of state.organizations) {
    state.evidence = newest(state.evidence, organization.id, MAX_EVIDENCE_PER_ORGANIZATION, (entry) => entry.uploadedAt);
    pruneAudit(state, organization.id, now);
  }
}

function pruneAudit(state: TeamControlPlaneState, organizationId: string, now: string): void {
  const cutoff = addDays(now, -AUDIT_RETENTION_DAYS);
  const all = state.audit.filter((entry) => entry.organizationId === organizationId).sort((left, right) => left.sequence - right.sequence);
  const retained = all.filter((entry) => entry.timestamp >= cutoff).slice(-MAX_AUDIT_PER_ORGANIZATION);
  if (retained.length === all.length) return;
  const removed = all.slice(0, all.length - retained.length);
  const anchor = state.auditAnchors.find((entry) => entry.organizationId === organizationId);
  if (anchor === undefined) throw new TeamControlPlaneError("Audit anchor is missing.");
  const boundary = removed.at(-1);
  if (boundary !== undefined) {
    anchor.sequence = boundary.sequence;
    anchor.hash = boundary.recordHash;
  }
  state.audit = state.audit.filter((entry) => entry.organizationId !== organizationId || retained.includes(entry));
}

function newest<T extends { organizationId: string }>(entries: T[], organizationId: string, max: number, key: (entry: T) => string): T[] {
  const allowed = new Set(entries.filter((entry) => entry.organizationId === organizationId).sort((left, right) => key(right).localeCompare(key(left))).slice(0, max));
  return entries.filter((entry) => entry.organizationId !== organizationId || allowed.has(entry));
}

function validateTokenScope(value: unknown, state: Pick<TeamControlPlaneState, "projects" | "environments">, organizationId: string): TeamTokenScope[] {
  const scopes = array(value, "Service token scope", MAX_SERVICE_TOKEN_SCOPES).map((raw) => {
    const entry = object(raw, "Service token scope is invalid."); exactKeys(entry, ["projectId", "environmentId", "permissions"], "Service token scope");
    const projectId = identifier(entry.projectId, "Service token scope project id"); const environmentId = identifier(entry.environmentId, "Service token scope environment id");
    if (!state.projects.some((project) => project.organizationId === organizationId && project.id === projectId) || !state.environments.some((environment) => environment.organizationId === organizationId && environment.projectId === projectId && environment.id === environmentId)) throw new TeamControlPlaneError("Service token scope is invalid.");
    const permissions = array(entry.permissions, "Service token permissions", SERVICE_ACCOUNT_PERMISSIONS.length).map((permission) => {
      if (typeof permission !== "string" || !isScopedPermission(permission) || !SERVICE_ACCOUNT_PERMISSIONS.includes(permission)) throw new TeamControlPlaneError("Service token permissions are invalid.");
      return permission;
    });
    if (permissions.length === 0) throw new TeamControlPlaneError("Service token permissions are invalid.");
    unique(permissions, "Service token permissions");
    return { projectId, environmentId, permissions: permissions.sort() };
  });
  if (scopes.length === 0) throw new TeamControlPlaneError("Service token scope is invalid.");
  unique(scopes.map((scope) => scopedKey(scope.projectId, scope.environmentId)), "Service token scope");
  return scopes.sort((left, right) => scopedKey(left.projectId, left.environmentId).localeCompare(scopedKey(right.projectId, right.environmentId)));
}

function canReadEvidence(state: TeamControlPlaneState, actor: TeamActor, evidence: TeamEvidence): boolean {
  return !isServiceActor(actor) || serviceTokenScopes(state, actor).some((scope) => scope.projectId === evidence.projectId && scope.environmentId === evidence.environmentId && scope.permissions.includes("evidence.read"));
}

function isServiceActor(actor: TeamActor): actor is Extract<TeamActor, { actorType: "service_account" }> {
  return actor.actorType === "service_account";
}

function serviceTokenScopes(state: TeamControlPlaneState, actor: Extract<TeamActor, { actorType: "service_account" }>): TeamTokenScope[] {
  const clock = authenticatedServiceActors.get(actor);
  if (clock === undefined) throw new TeamControlPlaneError("Access denied.");
  const tokenId = identifier(actor.tokenId, "Token id");
  const token = state.tokens.find((candidate) => candidate.id === tokenId && candidate.organizationId === actor.organizationId && candidate.type === "service" && candidate.subjectId === actor.serviceAccountId);
  if (token === undefined || token.revokedAt !== undefined || new Date(token.expiresAt).getTime() <= clock().getTime()) throw new TeamControlPlaneError("Access denied.");
  return validateTokenScope(token.scope, state, actor.organizationId);
}

function actorId(actor: TeamActor): string {
  return isServiceActor(actor) ? `service:${identifier(actor.serviceAccountId, "Service account id")}` : identifier(actor.memberId, "Member id");
}

function userActorId(actor: TeamActor): string {
  if (isServiceActor(actor)) throw new TeamControlPlaneError("Service accounts cannot impersonate a human member.");
  return identifier(actor.memberId, "Member id");
}

function actorReference(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TeamControlPlaneError(`${label} is invalid.`);
  if (value.startsWith("service:")) return `service:${identifier(value.slice("service:".length), label)}`;
  return identifier(value, label);
}

function actorReferenceIds(members: TeamMember[], serviceAccounts: TeamServiceAccount[]): Set<string> {
  return new Set([...members.map((member) => scopedKey(member.organizationId, member.id)), ...serviceAccounts.map((account) => scopedKey(account.organizationId, `service:${account.id}`))]);
}

function actorReferenceExists(organizationId: string, actorIdValue: unknown, members: TeamMember[], serviceAccounts: TeamServiceAccount[]): boolean {
  const id = actorReference(actorIdValue, "Actor id");
  return members.some((member) => member.organizationId === organizationId && member.id === id) || (id.startsWith("service:") && serviceAccounts.some((account) => account.organizationId === organizationId && account.id === id.slice("service:".length)));
}

function rejectRawEvidence(report: EvidenceReport): void {
  const encoded = JSON.stringify(report);
  if (Buffer.byteLength(encoded, "utf8") > 512 * 1024) throw new TeamControlPlaneError("Evidence artifact exceeds 524288 bytes.");
  const prohibited = new Set(["authorization", "cookie", "set-cookie", "rawbody"]);
  const visit = (value: unknown, key?: string): void => {
    if (key !== undefined && prohibited.has(key.toLowerCase())) throw new TeamControlPlaneError("Evidence artifact contains an unsafe raw field.");
    if (typeof value === "string" && sanitizeSecretString(value) !== value) throw new TeamControlPlaneError("Evidence artifact contains a secret-shaped value.");
    if (Array.isArray(value)) for (const item of value) visit(item, key);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) visit(child, childKey);
  };
  visit(report);
}

function safeJson(value: unknown, label: string, maxBytes: number): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maxBytes) throw new TeamControlPlaneError(`${label} exceeds ${maxBytes} bytes.`);
  inspectJson(value, label, 0);
  return JSON.parse(encoded) as unknown;
}

function inspectJson(value: unknown, label: string, depth: number, key?: string): void {
  if (depth > 8) throw new TeamControlPlaneError(`${label} is too deeply nested.`);
  if (key !== undefined && isSecretFieldName(key)) throw new TeamControlPlaneError(`${label} contains a secret-shaped field.`);
  if (typeof value === "string") {
    if (value.length > 2_000 || sanitizeSecretString(value) !== value) throw new TeamControlPlaneError(`${label} contains an unsafe string value.`);
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) { if (value.length > 100) throw new TeamControlPlaneError(`${label} has too many entries.`); for (const entry of value) inspectJson(entry, label, depth + 1, key); return; }
  if (!plainObject(value)) throw new TeamControlPlaneError(`${label} must contain JSON values only.`);
  const entries = Object.entries(value); if (entries.length > 100) throw new TeamControlPlaneError(`${label} has too many fields.`);
  for (const [childKey, child] of entries) inspectJson(child, label, depth + 1, childKey);
}

function validatePolicy(policy: GhostApiPolicy): void {
  const candidate = policy as unknown as Record<string, unknown>;
  if (candidate.version !== 1 || !plainObject(candidate.network) || !plainObject(candidate.credentials) || !Array.isArray(candidate.requiredScenarios) || !plainObject(candidate.enforcement) || !plainObject(candidate.reports)) throw new TeamControlPlaneError("Team policy does not match GhostAPI policy schema v1.");
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableHash(value: unknown): string { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function auditGenesisHash(organizationId: string): string { return hash(`ghostapi-team-audit-v3:${organizationId}`); }
function equalHash(left: string, right: string): boolean { return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex")); }
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function scopedKey(...parts: string[]): string { return parts.join("\u0000"); }
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new TeamControlPlaneError(`${label} must be 1-64 lowercase letters, numbers, underscores, or hyphens.`); return value; }
function runId(value: unknown): string { if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\u0000-\u001f]/.test(value) || sanitizeSecretString(value) !== value) throw new TeamControlPlaneError("Evidence run id is invalid."); return value; }
function text(value: unknown, label: string, max: number): string { if (typeof value !== "string" || value.trim() === "" || value.length > max || /[\u0000-\u001f]/.test(value) || sanitizeSecretString(value) !== value) throw new TeamControlPlaneError(`${label} is invalid.`); return value.trim(); }
function timestamp(value: unknown, label: string): string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(new Date(value).getTime())) throw new TeamControlPlaneError(`${label} is invalid.`); return value; }
function futureTimestamp(value: unknown, now: Date): string { const result = timestamp(value, "Token expiry"); const milliseconds = new Date(result).getTime(); if (milliseconds <= now.getTime() || milliseconds > now.getTime() + 90 * 24 * 60 * 60 * 1000) throw new TeamControlPlaneError("Token expiry must be within the next 90 days."); return result; }
function positiveInteger(value: unknown, label: string): number { if (!nonNegativeInteger(value) || value < 1 || value > 100_000) throw new TeamControlPlaneError(`${label} is invalid.`); return value; }
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
function list(value: unknown, label: string, dotted = false): string[] { if (!Array.isArray(value) || value.length > 100) throw new TeamControlPlaneError(`${label} are invalid.`); const result = value.map((entry) => { if (typeof entry !== "string" || (dotted ? !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry) : !IDENTIFIER.test(entry))) throw new TeamControlPlaneError(`${label} are invalid.`); return entry; }); unique(result, label); return result.sort(); }
function object(value: unknown, message: string): Record<string, unknown> { if (!plainObject(value)) throw new TeamControlPlaneError(message); return value; }
function plainObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function array(value: unknown, label: string, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new TeamControlPlaneError(`${label} are invalid.`); return value; }
function exactKeys(value: Record<string, unknown>, allowed: string[], label: string, optional: string[] = []): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TeamControlPlaneError(`${label} contains unsupported field: ${key}.`); for (const key of allowed) if (!optional.includes(key) && !(key in value)) throw new TeamControlPlaneError(`${label} is missing field: ${key}.`); }
function unique(values: string[], label: string): void { if (new Set(values).size !== values.length) throw new TeamControlPlaneError(`${label} must be unique.`); }
function runStatus(value: unknown): value is TeamEvidence["status"] { return value === "unknown" || value === "preparing" || value === "running" || value === "failed-to-start" || value === "finished"; }
function evidenceMode(value: unknown): value is TeamEvidence["enforcement"]["mode"] { return value === "linux-network-namespace" || value === "proxy-guidance" || value === "unknown"; }
function isScopedPermission(value: string): value is TeamScopedPermission { return READ_PERMISSIONS.includes(value as TeamScopedPermission) || PUBLISH_PERMISSIONS.includes(value as TeamScopedPermission); }
function addDays(value: string, days: number): string { return new Date(new Date(value).getTime() + days * 24 * 60 * 60 * 1000).toISOString(); }
function isErrorCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
