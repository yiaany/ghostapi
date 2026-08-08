import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { validateEvidenceReport, type EvidenceReport } from "../evidence/index.js";
import type { GhostApiPolicy } from "../policy/index.js";
import { isSecretFieldName, sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";

const SCHEMA_VERSION = 2;
const MAX_STORE_BYTES = 1024 * 1024;
const TOKEN_PREFIX = "gapi_team_";
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_EVIDENCE_PER_ORGANIZATION = 100;
const MAX_AUDIT_PER_ORGANIZATION = 1_000;
const EVIDENCE_RETENTION_DAYS = 30;
const AUDIT_RETENTION_DAYS = 90;

export type TeamRole = "owner" | "admin" | "member";
export type TeamEnvironmentKind = "development" | "ci";
export type TeamActor = { organizationId: string; memberId: string };
export type TeamOrganization = { id: string; name: string; createdAt: string };
export type TeamMember = { id: string; organizationId: string; role: TeamRole; createdAt: string };
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
export type TeamAuditRecord = { organizationId: string; actorId: string; action: string; resource: string; timestamp: string };

type TeamToken = { id: string; organizationId: string; memberId: string; digest: string; issuedBy: string; issuedAt: string; expiresAt: string; revokedAt?: string };
export type TeamControlPlaneState = { schemaVersion: 2; organizations: TeamOrganization[]; members: TeamMember[]; projects: TeamProject[]; environments: TeamEnvironment[]; tokens: TeamToken[]; scenarios: TeamScenarioVersion[]; evidence: TeamEvidence[]; policies: TeamPolicyVersion[]; audit: TeamAuditRecord[] };
export type LocalTeamControlPlaneOptions = { path?: string; now?: () => Date; randomTokenBytes?: (size: number) => Buffer };

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
      audit(state, organizationId, ownerId, "organization.bootstrap", organizationId, now);
      return organization;
    });
  }

  async addMember(actor: TeamActor, input: { memberId: string; role: Exclude<TeamRole, "owner"> }): Promise<TeamMember> {
    const memberId = identifier(input.memberId, "Member id");
    if (input.role !== "admin" && input.role !== "member") throw new TeamControlPlaneError("Member role is invalid.");
    return this.mutate((state, now) => {
      requireAdmin(state, actor);
      if (state.members.some((member) => member.organizationId === actor.organizationId && member.id === memberId)) throw new TeamControlPlaneError("Member already exists.");
      const member = { id: memberId, organizationId: actor.organizationId, role: input.role, createdAt: now };
      state.members.push(member);
      audit(state, actor.organizationId, actor.memberId, "member.add", memberId, now);
      return member;
    });
  }

  async registerProject(actor: TeamActor, input: { projectId: string; name: string }): Promise<TeamProject> {
    const projectId = identifier(input.projectId, "Project id");
    const name = text(input.name, "Project name", 120);
    return this.mutate((state, now) => {
      requireAdmin(state, actor);
      if (state.projects.some((project) => project.organizationId === actor.organizationId && project.id === projectId)) throw new TeamControlPlaneError("Project already exists.");
      const project = { id: projectId, organizationId: actor.organizationId, name, createdAt: now };
      state.projects.push(project);
      audit(state, actor.organizationId, actor.memberId, "project.register", projectId, now);
      return project;
    });
  }

  async createEnvironment(actor: TeamActor, input: { environmentId: string; projectId: string; name: string; kind: TeamEnvironmentKind }): Promise<TeamEnvironment> {
    const environmentId = identifier(input.environmentId, "Environment id");
    const projectId = identifier(input.projectId, "Project id");
    const name = text(input.name, "Environment name", 80);
    if (input.kind !== "development" && input.kind !== "ci") throw new TeamControlPlaneError("Environment kind is invalid.");
    return this.mutate((state, now) => {
      requireAdmin(state, actor);
      requireProject(state, actor.organizationId, projectId);
      if (state.environments.some((environment) => environment.organizationId === actor.organizationId && environment.projectId === projectId && environment.id === environmentId)) throw new TeamControlPlaneError("Environment already exists.");
      const environment = { id: environmentId, organizationId: actor.organizationId, projectId, name, kind: input.kind, createdAt: now };
      state.environments.push(environment);
      audit(state, actor.organizationId, actor.memberId, "environment.create", environmentId, now);
      return environment;
    });
  }

  async issueToken(actor: TeamActor, input: { memberId?: string; expiresAt: string }): Promise<{ tokenId: string; token: string; expiresAt: string }> {
    const expiresAt = futureTimestamp(input.expiresAt, this.now());
    return this.mutate((state, now) => {
      requireAdmin(state, actor);
      const memberId = input.memberId === undefined ? actor.memberId : identifier(input.memberId, "Token member id");
      requireMember(state, { organizationId: actor.organizationId, memberId });
      const tokenId = `tok_${this.randomTokenBytes(8).toString("hex")}`;
      const token = `${TOKEN_PREFIX}${this.randomTokenBytes(32).toString("base64url")}`;
      state.tokens.push({ id: tokenId, organizationId: actor.organizationId, memberId, digest: hash(token), issuedBy: actor.memberId, issuedAt: now, expiresAt });
      audit(state, actor.organizationId, actor.memberId, "token.issue", tokenId, now);
      return { tokenId, token, expiresAt };
    });
  }

  async revokeToken(actor: TeamActor, tokenId: string): Promise<void> {
    const id = identifier(tokenId, "Token id");
    await this.mutate((state, now) => {
      requireAdmin(state, actor);
      const token = state.tokens.find((candidate) => candidate.id === id && candidate.organizationId === actor.organizationId);
      if (token === undefined) throw new TeamControlPlaneError("Resource not found.");
      if (token.revokedAt === undefined) token.revokedAt = now;
      audit(state, actor.organizationId, actor.memberId, "token.revoke", id, now);
    });
  }

  async authenticateToken(token: string): Promise<TeamActor> {
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 256) throw new TeamControlPlaneError("Invalid or expired token.");
    const state = await this.read();
    const digest = hash(token);
    const record = state.tokens.find((candidate) => equalHash(candidate.digest, digest));
    if (record === undefined || record.revokedAt !== undefined || new Date(record.expiresAt).getTime() <= this.now().getTime()) throw new TeamControlPlaneError("Invalid or expired token.");
    requireMember(state, { organizationId: record.organizationId, memberId: record.memberId });
    return { organizationId: record.organizationId, memberId: record.memberId };
  }

  async publishScenario(actor: TeamActor, input: { projectId: string; environmentId: string; scenarioId: string; version: number; title: string; metadata: Record<string, unknown> }): Promise<TeamScenarioVersion> {
    const projectId = identifier(input.projectId, "Project id");
    const environmentId = identifier(input.environmentId, "Environment id");
    const scenarioId = identifier(input.scenarioId, "Scenario id");
    const version = positiveInteger(input.version, "Scenario version");
    const title = text(input.title, "Scenario title", 160);
    const metadata = safeJson(input.metadata, "Scenario metadata", 16 * 1024) as Record<string, unknown>;
    return this.mutate((state, now) => {
      requireMember(state, actor);
      requireProject(state, actor.organizationId, projectId);
      requireEnvironment(state, actor.organizationId, projectId, environmentId);
      if (state.scenarios.some((scenario) => scenario.organizationId === actor.organizationId && scenario.projectId === projectId && scenario.environmentId === environmentId && scenario.scenarioId === scenarioId && scenario.version === version)) throw new TeamControlPlaneError("Scenario version already exists.");
      const scenario = { organizationId: actor.organizationId, projectId, environmentId, scenarioId, version, title, metadata, createdBy: actor.memberId, createdAt: now };
      state.scenarios.push(scenario);
      audit(state, actor.organizationId, actor.memberId, "scenario.publish", `${scenarioId}@${version}`, now);
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
      requireMember(state, actor);
      requireProject(state, actor.organizationId, projectId);
      requireEnvironment(state, actor.organizationId, projectId, environmentId);
      if (state.evidence.some((evidence) => evidence.organizationId === actor.organizationId && evidence.id === evidenceId)) throw new TeamControlPlaneError("Evidence already exists.");
      const evidence: TeamEvidence = {
        id: evidenceId, organizationId: actor.organizationId, projectId, environmentId, runId: runId(report.run.id), evidenceHash: report.artifact.logicalHash, status: report.run.status,
        passed: report.summary.passed, failCount: report.summary.failCount, warningCount: report.summary.warningCount, providers: list(report.coverage.providers, "Evidence providers"), scenarios: list(report.coverage.scenarios, "Evidence scenarios", true),
        enforcement: { mode: report.enforcement.mode, isolated: report.enforcement.isolated, degraded: report.enforcement.degraded }, uploadedBy: actor.memberId, uploadedAt: now, expiresAt: addDays(now, EVIDENCE_RETENTION_DAYS)
      };
      state.evidence.push(evidence);
      audit(state, actor.organizationId, actor.memberId, "evidence.upload", evidenceId, now);
      return evidence;
    });
  }

  async distributePolicy(actor: TeamActor, input: { version: number; policy: GhostApiPolicy }): Promise<TeamPolicyVersion> {
    const version = positiveInteger(input.version, "Policy version");
    const policy = safeJson(input.policy, "Team policy", 32 * 1024) as GhostApiPolicy;
    validatePolicy(policy);
    return this.mutate((state, now) => {
      requireAdmin(state, actor);
      if (state.policies.some((candidate) => candidate.organizationId === actor.organizationId && candidate.version === version)) throw new TeamControlPlaneError("Policy version already exists.");
      const distributed = { organizationId: actor.organizationId, version, policy, hash: stableHash(policy), distributedBy: actor.memberId, distributedAt: now };
      state.policies.push(distributed);
      audit(state, actor.organizationId, actor.memberId, "policy.distribute", `policy@${version}`, now);
      return distributed;
    });
  }

  async listProjects(actor: TeamActor): Promise<TeamProject[]> {
    const state = await this.read();
    requireMember(state, actor);
    return state.projects.filter((project) => project.organizationId === actor.organizationId).map((project) => structuredClone(project));
  }

  async listEvidence(actor: TeamActor, projectId: string): Promise<TeamEvidence[]> {
    const id = identifier(projectId, "Project id");
    const state = await this.read();
    requireMember(state, actor);
    requireProject(state, actor.organizationId, id);
    return state.evidence.filter((evidence) => evidence.organizationId === actor.organizationId && evidence.projectId === id).map((evidence) => structuredClone(evidence));
  }

  async listScenarioVersions(actor: TeamActor, input: { projectId: string; environmentId: string; scenarioId: string }): Promise<TeamScenarioVersion[]> {
    const projectId = identifier(input.projectId, "Project id");
    const environmentId = identifier(input.environmentId, "Environment id");
    const scenarioId = identifier(input.scenarioId, "Scenario id");
    const state = await this.read();
    requireMember(state, actor);
    requireEnvironment(state, actor.organizationId, projectId, environmentId);
    return state.scenarios.filter((scenario) => scenario.organizationId === actor.organizationId && scenario.projectId === projectId && scenario.environmentId === environmentId && scenario.scenarioId === scenarioId).sort((left, right) => left.version - right.version).map((scenario) => structuredClone(scenario));
  }

  async getLatestPolicy(actor: TeamActor): Promise<TeamPolicyVersion | null> {
    const state = await this.read();
    requireMember(state, actor);
    const policy = state.policies.filter((candidate) => candidate.organizationId === actor.organizationId).sort((left, right) => right.version - left.version)[0];
    return policy === undefined ? null : structuredClone(policy);
  }

  async listAudit(actor: TeamActor): Promise<TeamAuditRecord[]> {
    const state = await this.read();
    requireAdmin(state, actor);
    return state.audit.filter((record) => record.organizationId === actor.organizationId).map((record) => structuredClone(record));
  }

  async pruneRetention(actor: TeamActor): Promise<{ evidenceRemoved: number; auditRemoved: number }> {
    return this.mutate((state, now) => {
      requireAdmin(state, actor);
      const beforeEvidence = state.evidence.length;
      const beforeAudit = state.audit.length;
      retain(state, now);
      const result = { evidenceRemoved: beforeEvidence - state.evidence.length, auditRemoved: beforeAudit - state.audit.length };
      audit(state, actor.organizationId, actor.memberId, "retention.prune", "team-control-plane", now);
      return result;
    }, false);
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
      return migrateTeamControlPlane(JSON.parse(source));
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

export function migrateTeamControlPlane(value: unknown): TeamControlPlaneState {
  const state = object(value, "Team control-plane store must be an object.");
  if (state.schemaVersion === 1) {
    exactKeys(state, ["schemaVersion", "organizations", "members", "projects", "environments", "tokens", "scenarios", "evidence", "policies"], "Team control-plane v1 store");
    return validateState({ ...state, schemaVersion: 2, audit: [] });
  }
  return validateState(state);
}

function emptyState(): TeamControlPlaneState {
  return { schemaVersion: 2, organizations: [], members: [], projects: [], environments: [], tokens: [], scenarios: [], evidence: [], policies: [], audit: [] };
}

function validateState(value: unknown): TeamControlPlaneState {
  const state = object(value, "Team control-plane store must be an object.");
  exactKeys(state, ["schemaVersion", "organizations", "members", "projects", "environments", "tokens", "scenarios", "evidence", "policies", "audit"], "Team control-plane store");
  if (state.schemaVersion !== SCHEMA_VERSION) throw new TeamControlPlaneError("Unsupported team control-plane schema version.");
  const organizations = array(state.organizations, "Organizations", 100).map((entry) => {
    const organization = object(entry, "Organization is invalid."); exactKeys(organization, ["id", "name", "createdAt"], "Organization");
    return { id: identifier(organization.id, "Organization id"), name: text(organization.name, "Organization name", 120), createdAt: timestamp(organization.createdAt, "Organization createdAt") };
  });
  unique(organizations.map((entry) => entry.id), "Organization ids");
  const organizationIds = new Set(organizations.map((entry) => entry.id));
  const members = array(state.members, "Members", 1_000).map((entry) => member(entry, organizationIds));
  unique(members.map((entry) => `${entry.organizationId}:${entry.id}`), "Organization member ids");
  for (const organization of organizations) if (!members.some((candidate) => candidate.organizationId === organization.id && candidate.role === "owner")) throw new TeamControlPlaneError("Each organization requires an owner.");
  const projects = array(state.projects, "Projects", 1_000).map((entry) => project(entry, organizationIds));
  unique(projects.map((entry) => scopedKey(entry.organizationId, entry.id)), "Organization project ids");
  const projectOwners = new Map(projects.map((entry) => [scopedKey(entry.organizationId, entry.id), entry.organizationId]));
  const environments = array(state.environments, "Environments", 2_000).map((entry) => environment(entry, organizationIds, projectOwners));
  unique(environments.map((entry) => scopedKey(entry.organizationId, entry.projectId, entry.id)), "Project environment ids");
  const environmentsById = new Map(environments.map((entry) => [scopedKey(entry.organizationId, entry.projectId, entry.id), entry]));
  const tokens = array(state.tokens, "Tokens", 10_000).map((entry) => token(entry, organizationIds, members));
  unique(tokens.map((entry) => entry.id), "Token ids");
  const scenarios = array(state.scenarios, "Scenarios", 10_000).map((entry) => scenario(entry, organizationIds, projectOwners, environmentsById, members));
  unique(scenarios.map((entry) => `${entry.organizationId}:${entry.projectId}:${entry.environmentId}:${entry.scenarioId}:${entry.version}`), "Scenario versions");
  const evidence = array(state.evidence, "Evidence", 10_000).map((entry) => evidenceRecord(entry, organizationIds, projectOwners, environmentsById, members));
  unique(evidence.map((entry) => scopedKey(entry.organizationId, entry.id)), "Organization evidence ids");
  const policies = array(state.policies, "Policies", 10_000).map((entry) => policyVersion(entry, organizationIds, members));
  unique(policies.map((entry) => `${entry.organizationId}:${entry.version}`), "Policy versions");
  const auditRecords = array(state.audit, "Audit records", 100_000).map((entry) => auditRecord(entry, organizationIds, members));
  return { schemaVersion: 2, organizations, members, projects, environments, tokens, scenarios, evidence, policies, audit: auditRecords };
}

function member(value: unknown, organizations: Set<string>): TeamMember {
  const entry = object(value, "Member is invalid."); exactKeys(entry, ["id", "organizationId", "role", "createdAt"], "Member");
  const organizationId = identifier(entry.organizationId, "Member organization id");
  if (!organizations.has(organizationId) || (entry.role !== "owner" && entry.role !== "admin" && entry.role !== "member")) throw new TeamControlPlaneError("Member is invalid.");
  return { id: identifier(entry.id, "Member id"), organizationId, role: entry.role, createdAt: timestamp(entry.createdAt, "Member createdAt") };
}

function project(value: unknown, organizations: Set<string>): TeamProject {
  const entry = object(value, "Project is invalid."); exactKeys(entry, ["id", "organizationId", "name", "createdAt"], "Project");
  const organizationId = identifier(entry.organizationId, "Project organization id"); if (!organizations.has(organizationId)) throw new TeamControlPlaneError("Project organization is invalid.");
  return { id: identifier(entry.id, "Project id"), organizationId, name: text(entry.name, "Project name", 120), createdAt: timestamp(entry.createdAt, "Project createdAt") };
}

function environment(value: unknown, organizations: Set<string>, projects: Map<string, string>): TeamEnvironment {
  const entry = object(value, "Environment is invalid."); exactKeys(entry, ["id", "organizationId", "projectId", "name", "kind", "createdAt"], "Environment");
  const organizationId = identifier(entry.organizationId, "Environment organization id"); const projectId = identifier(entry.projectId, "Environment project id");
  if (!organizations.has(organizationId) || projects.get(scopedKey(organizationId, projectId)) !== organizationId || (entry.kind !== "development" && entry.kind !== "ci")) throw new TeamControlPlaneError("Environment is invalid.");
  return { id: identifier(entry.id, "Environment id"), organizationId, projectId, name: text(entry.name, "Environment name", 80), kind: entry.kind, createdAt: timestamp(entry.createdAt, "Environment createdAt") };
}

function token(value: unknown, organizations: Set<string>, members: TeamMember[]): TeamToken {
  const entry = object(value, "Token is invalid."); exactKeys(entry, ["id", "organizationId", "memberId", "digest", "issuedBy", "issuedAt", "expiresAt", "revokedAt"], "Token", ["revokedAt"]);
  const organizationId = identifier(entry.organizationId, "Token organization id"); const memberId = identifier(entry.memberId, "Token member id");
  if (!organizations.has(organizationId) || !members.some((candidate) => candidate.organizationId === organizationId && candidate.id === memberId) || !members.some((candidate) => candidate.organizationId === organizationId && candidate.id === entry.issuedBy) || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest)) throw new TeamControlPlaneError("Token is invalid.");
  return { id: identifier(entry.id, "Token id"), organizationId, memberId, digest: entry.digest, issuedBy: identifier(entry.issuedBy, "Token issuer id"), issuedAt: timestamp(entry.issuedAt, "Token issuedAt"), expiresAt: timestamp(entry.expiresAt, "Token expiresAt"), ...(entry.revokedAt === undefined ? {} : { revokedAt: timestamp(entry.revokedAt, "Token revokedAt") }) };
}

function scenario(value: unknown, organizations: Set<string>, projects: Map<string, string>, environments: Map<string, TeamEnvironment>, members: TeamMember[]): TeamScenarioVersion {
  const entry = object(value, "Scenario is invalid."); exactKeys(entry, ["organizationId", "projectId", "environmentId", "scenarioId", "version", "title", "metadata", "createdBy", "createdAt"], "Scenario");
  const organizationId = identifier(entry.organizationId, "Scenario organization id"); const projectId = identifier(entry.projectId, "Scenario project id"); const environmentId = identifier(entry.environmentId, "Scenario environment id");
  if (!organizations.has(organizationId) || projects.get(scopedKey(organizationId, projectId)) !== organizationId || environments.get(scopedKey(organizationId, projectId, environmentId))?.projectId !== projectId || !members.some((candidate) => candidate.organizationId === organizationId && candidate.id === entry.createdBy)) throw new TeamControlPlaneError("Scenario is invalid.");
  return { organizationId, projectId, environmentId, scenarioId: identifier(entry.scenarioId, "Scenario id"), version: positiveInteger(entry.version, "Scenario version"), title: text(entry.title, "Scenario title", 160), metadata: safeJson(entry.metadata, "Scenario metadata", 16 * 1024) as Record<string, unknown>, createdBy: identifier(entry.createdBy, "Scenario creator id"), createdAt: timestamp(entry.createdAt, "Scenario createdAt") };
}

function evidenceRecord(value: unknown, organizations: Set<string>, projects: Map<string, string>, environments: Map<string, TeamEnvironment>, members: TeamMember[]): TeamEvidence {
  const entry = object(value, "Evidence is invalid."); exactKeys(entry, ["id", "organizationId", "projectId", "environmentId", "runId", "evidenceHash", "status", "passed", "failCount", "warningCount", "providers", "scenarios", "enforcement", "uploadedBy", "uploadedAt", "expiresAt"], "Evidence");
  const organizationId = identifier(entry.organizationId, "Evidence organization id"); const projectId = identifier(entry.projectId, "Evidence project id"); const environmentId = identifier(entry.environmentId, "Evidence environment id"); const enforcement = object(entry.enforcement, "Evidence enforcement is invalid."); exactKeys(enforcement, ["mode", "isolated", "degraded"], "Evidence enforcement");
  if (!organizations.has(organizationId) || projects.get(scopedKey(organizationId, projectId)) !== organizationId || environments.get(scopedKey(organizationId, projectId, environmentId))?.projectId !== projectId || !members.some((candidate) => candidate.organizationId === organizationId && candidate.id === entry.uploadedBy) || typeof entry.evidenceHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.evidenceHash) || !runStatus(entry.status) || typeof entry.passed !== "boolean" || !nonNegativeInteger(entry.failCount) || !nonNegativeInteger(entry.warningCount) || !evidenceMode(enforcement.mode) || typeof enforcement.isolated !== "boolean" || typeof enforcement.degraded !== "boolean") throw new TeamControlPlaneError("Evidence is invalid.");
  return { id: identifier(entry.id, "Evidence id"), organizationId, projectId, environmentId, runId: runId(entry.runId), evidenceHash: entry.evidenceHash, status: entry.status, passed: entry.passed, failCount: entry.failCount, warningCount: entry.warningCount, providers: list(entry.providers, "Evidence providers"), scenarios: list(entry.scenarios, "Evidence scenarios", true), enforcement: { mode: enforcement.mode, isolated: enforcement.isolated, degraded: enforcement.degraded }, uploadedBy: identifier(entry.uploadedBy, "Evidence uploader id"), uploadedAt: timestamp(entry.uploadedAt, "Evidence uploadedAt"), expiresAt: timestamp(entry.expiresAt, "Evidence expiresAt") };
}

function policyVersion(value: unknown, organizations: Set<string>, members: TeamMember[]): TeamPolicyVersion {
  const entry = object(value, "Policy is invalid."); exactKeys(entry, ["organizationId", "version", "policy", "hash", "distributedBy", "distributedAt"], "Policy");
  const organizationId = identifier(entry.organizationId, "Policy organization id"); const policy = safeJson(entry.policy, "Team policy", 32 * 1024) as GhostApiPolicy; validatePolicy(policy);
  if (!organizations.has(organizationId) || !members.some((candidate) => candidate.organizationId === organizationId && candidate.id === entry.distributedBy) || typeof entry.hash !== "string" || entry.hash !== stableHash(policy)) throw new TeamControlPlaneError("Policy is invalid.");
  return { organizationId, version: positiveInteger(entry.version, "Policy version"), policy, hash: entry.hash, distributedBy: identifier(entry.distributedBy, "Policy distributor id"), distributedAt: timestamp(entry.distributedAt, "Policy distributedAt") };
}

function auditRecord(value: unknown, organizations: Set<string>, members: TeamMember[]): TeamAuditRecord {
  const entry = object(value, "Audit record is invalid."); exactKeys(entry, ["organizationId", "actorId", "action", "resource", "timestamp"], "Audit record");
  const organizationId = identifier(entry.organizationId, "Audit organization id"); const actorId = identifier(entry.actorId, "Audit actor id");
  if (!organizations.has(organizationId) || !members.some((candidate) => candidate.organizationId === organizationId && candidate.id === actorId)) throw new TeamControlPlaneError("Audit record is invalid.");
  return { organizationId, actorId, action: text(entry.action, "Audit action", 80), resource: text(entry.resource, "Audit resource", 160), timestamp: timestamp(entry.timestamp, "Audit timestamp") };
}

function requireMember(state: TeamControlPlaneState, actor: TeamActor): TeamMember {
  const organizationId = identifier(actor.organizationId, "Organization id"); const memberId = identifier(actor.memberId, "Member id");
  const member = state.members.find((candidate) => candidate.organizationId === organizationId && candidate.id === memberId);
  if (member === undefined) throw new TeamControlPlaneError("Access denied.");
  return member;
}

function requireAdmin(state: TeamControlPlaneState, actor: TeamActor): void {
  const member = requireMember(state, actor); if (member.role !== "owner" && member.role !== "admin") throw new TeamControlPlaneError("Access denied.");
}

function requireProject(state: TeamControlPlaneState, organizationId: string, projectId: string): void {
  if (!state.projects.some((candidate) => candidate.organizationId === organizationId && candidate.id === projectId)) throw new TeamControlPlaneError("Resource not found.");
}

function requireEnvironment(state: TeamControlPlaneState, organizationId: string, projectId: string, environmentId: string): void {
  if (!state.environments.some((candidate) => candidate.organizationId === organizationId && candidate.projectId === projectId && candidate.id === environmentId)) throw new TeamControlPlaneError("Resource not found.");
}

function audit(state: TeamControlPlaneState, organizationId: string, actorId: string, action: string, resource: string, timestampValue: string): void {
  state.audit.push({ organizationId, actorId, action, resource, timestamp: timestampValue });
}

function retain(state: TeamControlPlaneState, now: string): void {
  const cutoff = addDays(now, -AUDIT_RETENTION_DAYS);
  state.evidence = state.evidence.filter((entry) => entry.expiresAt > now);
  state.audit = state.audit.filter((entry) => entry.timestamp >= cutoff);
  for (const organization of state.organizations) {
    state.evidence = newest(state.evidence, organization.id, MAX_EVIDENCE_PER_ORGANIZATION, (entry) => entry.uploadedAt);
    state.audit = newest(state.audit, organization.id, MAX_AUDIT_PER_ORGANIZATION, (entry) => entry.timestamp);
  }
}

function newest<T extends { organizationId: string }>(entries: T[], organizationId: string, max: number, key: (entry: T) => string): T[] {
  const allowed = new Set(entries.filter((entry) => entry.organizationId === organizationId).sort((left, right) => key(right).localeCompare(key(left))).slice(0, max));
  return entries.filter((entry) => entry.organizationId !== organizationId || allowed.has(entry));
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
  if (typeof value !== "object") throw new TeamControlPlaneError(`${label} must contain JSON values only.`);
  const entries = Object.entries(value as Record<string, unknown>); if (entries.length > 100) throw new TeamControlPlaneError(`${label} has too many fields.`);
  for (const [childKey, child] of entries) inspectJson(child, label, depth + 1, childKey);
}

function validatePolicy(policy: GhostApiPolicy): void {
  const candidate = policy as unknown as Record<string, unknown>;
  if (candidate.version !== 1 || !plainObject(candidate.network) || !plainObject(candidate.credentials) || !Array.isArray(candidate.requiredScenarios) || !plainObject(candidate.enforcement) || !plainObject(candidate.reports)) throw new TeamControlPlaneError("Team policy does not match GhostAPI policy schema v1.");
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableHash(value: unknown): string { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function equalHash(left: string, right: string): boolean { return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex")); }
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
function positiveInteger(value: unknown, label: string): number { if (!nonNegativeInteger(value) || value < 1 || value > 10_000) throw new TeamControlPlaneError(`${label} is invalid.`); return value; }
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
function list(value: unknown, label: string, dotted = false): string[] { if (!Array.isArray(value) || value.length > 100) throw new TeamControlPlaneError(`${label} are invalid.`); const result = value.map((entry) => { if (typeof entry !== "string" || (dotted ? !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry) : !IDENTIFIER.test(entry))) throw new TeamControlPlaneError(`${label} are invalid.`); return entry; }); unique(result, label); return result.sort(); }
function object(value: unknown, message: string): Record<string, unknown> { if (!plainObject(value)) throw new TeamControlPlaneError(message); return value; }
function plainObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function array(value: unknown, label: string, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new TeamControlPlaneError(`${label} are invalid.`); return value; }
function exactKeys(value: Record<string, unknown>, allowed: string[], label: string, optional: string[] = []): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TeamControlPlaneError(`${label} contains unsupported field: ${key}.`); for (const key of allowed) if (!optional.includes(key) && !(key in value)) throw new TeamControlPlaneError(`${label} is missing field: ${key}.`); }
function unique(values: string[], label: string): void { if (new Set(values).size !== values.length) throw new TeamControlPlaneError(`${label} must be unique.`); }
function runStatus(value: unknown): value is TeamEvidence["status"] { return value === "unknown" || value === "preparing" || value === "running" || value === "failed-to-start" || value === "finished"; }
function evidenceMode(value: unknown): value is TeamEvidence["enforcement"]["mode"] { return value === "linux-network-namespace" || value === "proxy-guidance" || value === "unknown"; }
function addDays(value: string, days: number): string { return new Date(new Date(value).getTime() + days * 24 * 60 * 60 * 1000).toISOString(); }
function isErrorCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
