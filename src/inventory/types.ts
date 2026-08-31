import { createHash } from "node:crypto";
import { sanitizeSecretString } from "../security/secrets.js";

export const INVENTORY_SCHEMA_VERSION = 1;
export const INVENTORY_KIND = "ghostapi.inventory";

export const IMPORT_SOURCE_TYPES = [
  "config",
  "ci",
  "gateway",
  "cloud",
] as const;
export type ImportSourceType = (typeof IMPORT_SOURCE_TYPES)[number];

export const TOOL_KINDS = ["mcp_server", "sdk_client", "http_client"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export const IDENTITY_ROLES = ["service_account", "user", "workload"] as const;
export type IdentityRole = (typeof IDENTITY_ROLES)[number];

export const SIDE_EFFECT_KINDS = [
  "read",
  "create",
  "update",
  "communicate",
  "money_movement",
  "delete",
  "permission_change",
  "deployment",
] as const;
export type SideEffectKind = (typeof SIDE_EFFECT_KINDS)[number];

export const IMPACT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type ImpactSeverity = (typeof IMPACT_SEVERITIES)[number];

export const EDGE_RELATIONS = [
  "owns",
  "uses",
  "connects",
  "exposes",
  "permits",
  "requires",
] as const;
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

export const NODE_KINDS = [
  "agent",
  "identity",
  "tool",
  "provider",
  "resource",
  "side_effect",
  "credential",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const FINDING_KINDS = [
  "orphaned_agents",
  "stale_unused_credentials",
  "excessive_permissions",
  "unowned_production_integrations",
  "agents_outside_gateway",
  "missing_kill_switch",
  "missing_evidence",
  "policy_drift",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const FINDING_BASIS = ["evidence", "heuristic"] as const;
export type FindingBasis = (typeof FINDING_BASIS)[number];

export const FINDING_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const REMEDIATION_KINDS = [
  "assign_owner",
  "reduce_scope",
  "revoke",
  "onboard_through_gateway",
  "create_eval",
] as const;
export type RemediationKind = (typeof REMEDIATION_KINDS)[number];

export const REMEDIATION_STATUSES = [
  "proposed",
  "applied",
  "rejected",
  "expired",
] as const;
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];

export const FRESHNESS_DEFAULT_DAYS = {
  edgeStale: 90,
  credentialStale: 90,
  evidenceFresh: 30,
} as const;
export type InventoryFreshnessDays = {
  edgeStaleDays?: number;
  credentialStaleDays?: number;
  evidenceFreshDays?: number;
};

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SCOPE_IDENTIFIER = /^[a-z0-9][a-z0-9._:\-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const INVENTORY_LIMITS = {
  maxStoreBytes: 8 * 1024 * 1024,
  maxSources: 64,
  maxImports: 256,
  maxAgents: 500,
  maxTools: 500,
  maxIdentities: 500,
  maxProviders: 200,
  maxResources: 1000,
  maxSideEffects: 2000,
  maxCredentials: 500,
  maxPolicies: 100,
  maxEdges: 6000,
  maxFindings: 3000,
  maxRemediations: 1000,
  maxReferencesPerRecord: 64,
  maxScopesPerRecord: 32,
  maxCounters: 3,
} as const;

export type InventoryOperatorPermission =
  | "inventory.import"
  | "inventory.inspect"
  | "inventory.analyze"
  | "inventory.remediate"
  | "inventory.export";
export type InventoryOperator = {
  id: string;
  principalId: string;
  tenantId: string;
  permissions: readonly InventoryOperatorPermission[];
};
export interface InventoryOperatorAuthorizer {
  authenticate(identity: unknown): Promise<InventoryOperator>;
}

export type RecordProvenance = {
  sourceId: string;
  sourceType: ImportSourceType;
  sourceName: string;
  importedAt: string;
  importedBy: string;
};
export type RecordFreshness = { firstSeenAt: string; lastSeenAt: string };
export type FreshnessStatus = "fresh" | "stale" | "missing";

export type AgentRecord = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-agent";
  tenantId: string;
  agentId: string;
  name: string;
  ownerId: string | null;
  businessPurpose?: string;
  model?: string;
  runtime?: string;
  version?: string;
  identityIds: string[];
  environmentIds: string[];
  gatewayManaged: boolean;
  killSwitchEnabled: boolean;
  lastEvidenceAt: string | null;
  provenance: RecordProvenance;
  freshness: RecordFreshness;
};

export type ToolRecord = {
  schemaVersion: 1;
  tenantId: string;
  toolId: string;
  name: string;
  kind: ToolKind;
  providerId: string | null;
  requiredScopes: string[];
  credentialIds: string[];
  provenance: RecordProvenance;
  freshness: RecordFreshness;
};

export type IdentityRecord = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-identity";
  tenantId: string;
  identityId: string;
  principalId: string;
  role: IdentityRole;
  agentId: string | null;
  toolIds: string[];
  environmentIds: string[];
  scopes: string[];
  provenance: RecordProvenance;
  freshness: RecordFreshness;
};

export type ProviderRecord = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-provider";
  tenantId: string;
  providerId: string;
  name: string;
  providerType: string;
  ownerId: string | null;
  environmentIds: string[];
  resourceIds: string[];
  gatewayBound: boolean;
  killSwitchApplied: boolean;
  provenance: RecordProvenance;
  freshness: RecordFreshness;
};

export type ResourceRecord = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-resource";
  tenantId: string;
  resourceId: string;
  providerId: string;
  resourceType: string;
  name: string;
  environmentIds: string[];
  sensitive: boolean;
  ownerId: string | null;
  businessPurpose?: string;
  sideEffectIds: string[];
  provenance: RecordProvenance;
  freshness: RecordFreshness;
};

export type SideEffectRecord = {
  schemaVersion: 1;
  tenantId: string;
  sideEffectId: string;
  resourceId: string;
  kind: SideEffectKind;
  severity: ImpactSeverity;
  provenance: RecordProvenance;
  freshness: RecordFreshness;
};

export type CredentialRecord = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-credential";
  tenantId: string;
  credentialId: string;
  name: string;
  providerId: string;
  ownerId: string | null;
  environmentIds: string[];
  grantScopes: string[];
  toolIds: string[];
  status: "active" | "revoked";
  issuedAt: string;
  lastUsedAt: string | null;
  rotatedAt?: string;
  gatewayBound: boolean;
  provenance: RecordProvenance;
  freshness: RecordFreshness;
};

export type PolicyRecord = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-policy";
  tenantId: string;
  policyId: string;
  name: string;
  version: string;
  hash: string;
  environmentIds: string[];
  provenance: RecordProvenance;
  freshness: RecordFreshness;
};

export type GraphEdge = {
  tenantId: string;
  edgeId: string;
  sourceKind: NodeKind;
  sourceId: string;
  targetKind: NodeKind;
  targetId: string;
  relation: EdgeRelation;
  provenance: RecordProvenance;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type FindingRecord = {
  schemaVersion: 1;
  tenantId: string;
  findingId: string;
  kind: FindingKind;
  severity: FindingSeverity;
  targetKind: NodeKind | "environment" | "policy";
  targetId: string;
  ruleId: string;
  reason: string;
  basis: FindingBasis;
  discoveredAt: string;
  status: "open" | "resolved";
  resolvedAt?: string;
  remediationId?: string;
};

export type RemediationRecord = {
  schemaVersion: 1;
  tenantId: string;
  remediationId: string;
  findingId: string;
  kind: RemediationKind;
  targetKind: NodeKind | "environment" | "policy";
  targetId: string;
  rationale: string;
  proposedBy: string;
  createdAt: string;
  status: RemediationStatus;
  appliedAt?: string;
  result?: {
    description: string;
    reducedScopes?: string[];
    evalScenarioId?: string;
    ownerId?: string;
  };
};

export type ImportSourceRecord = {
  tenantId: string;
  sourceId: string;
  sourceType: ImportSourceType;
  sourceName: string;
  sourceVersion?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastDigest: string;
};

export type ExpectedPolicyHash = { environmentId: string; policyHash: string };

export type ImportCounters = {
  preventedEgressAttempts?: number;
  reviewTimeMinutes?: number;
  meanTimeToContainMinutes?: number;
};

export type ImportRunRecord = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-import-run";
  tenantId: string;
  runId: string;
  importedAt: string;
  importedBy: string;
  source: {
    sourceId: string;
    sourceType: ImportSourceType;
    sourceName: string;
    sourceVersion?: string;
  };
  digest: string;
  expectedPolicyHashes: ExpectedPolicyHash[];
  counters?: ImportCounters;
  recordCounts: {
    agents: number;
    tools: number;
    identities: number;
    providers: number;
    resources: number;
    sideEffects: number;
    credentials: number;
    policies: number;
  };
  edgesCreated: number;
  edgesRefreshed: number;
  status: "completed";
};

export type InventoryStoreState = {
  schemaVersion: 1;
  kind: "ghostapi.inventory";
  sources: ImportSourceRecord[];
  importRuns: ImportRunRecord[];
  agents: AgentRecord[];
  tools: ToolRecord[];
  identities: IdentityRecord[];
  providers: ProviderRecord[];
  resources: ResourceRecord[];
  sideEffects: SideEffectRecord[];
  credentials: CredentialRecord[];
  policies: PolicyRecord[];
  edges: GraphEdge[];
  findings: FindingRecord[];
  remediations: RemediationRecord[];
};

export type ImportedAgent = {
  agentId: string;
  name: string;
  ownerId?: string;
  businessPurpose?: string;
  model?: string;
  runtime?: string;
  version?: string;
  identityIds: string[];
  environmentIds: string[];
  gatewayManaged: boolean;
  killSwitchEnabled: boolean;
  lastEvidenceAt?: string;
};

export type ImportedTool = {
  toolId: string;
  name: string;
  kind: ToolKind;
  providerId?: string;
  requiredScopes: string[];
  credentialIds: string[];
};

export type ImportedIdentity = {
  identityId: string;
  principalId: string;
  role: IdentityRole;
  agentId?: string;
  toolIds: string[];
  environmentIds: string[];
  scopes: string[];
};

export type ImportedProvider = {
  providerId: string;
  name: string;
  providerType: string;
  ownerId?: string;
  environmentIds: string[];
  resourceIds: string[];
  gatewayBound: boolean;
  killSwitchApplied: boolean;
};

export type ImportedResource = {
  resourceId: string;
  providerId: string;
  resourceType: string;
  name: string;
  environmentIds: string[];
  sensitive: boolean;
  ownerId?: string;
  businessPurpose?: string;
  sideEffectIds: string[];
};

export type ImportedSideEffect = {
  sideEffectId: string;
  resourceId: string;
  kind: SideEffectKind;
  severity: ImpactSeverity;
};

export type ImportedCredential = {
  credentialId: string;
  name: string;
  providerId: string;
  ownerId?: string;
  environmentIds: string[];
  grantScopes: string[];
  toolIds: string[];
  status: "active" | "revoked";
  issuedAt: string;
  lastUsedAt?: string;
  rotatedAt?: string;
  gatewayBound: boolean;
};

export type ImportedPolicy = {
  policyId: string;
  name: string;
  version: string;
  hash: string;
  environmentIds: string[];
};

export type InventoryImportPayload = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-import";
  source: {
    sourceId: string;
    sourceType: ImportSourceType;
    sourceName: string;
    sourceVersion?: string;
  };
  expectedPolicyHashes?: ExpectedPolicyHash[];
  counters?: ImportCounters;
  agents?: ImportedAgent[];
  tools?: ImportedTool[];
  identities?: ImportedIdentity[];
  providers?: ImportedProvider[];
  resources?: ImportedResource[];
  sideEffects?: ImportedSideEffect[];
  credentials?: ImportedCredential[];
  policies?: ImportedPolicy[];
};

export type GraphEdgeView = GraphEdge & { freshnessStatus: FreshnessStatus };

export type AttackPathStep = { kind: NodeKind; id: string; display: string };
export type AttackPath = {
  steps: AttackPathStep[];
  complete: boolean;
  edges: GraphEdge[];
};

export type AttackPathResult = {
  agentId: string;
  paths: AttackPath[];
  incompletePaths: number;
};

export type BlastRadiusRule = { ruleId: string; explanation: string };

export type BlastRadiusResource = {
  resourceId: string;
  resourceType: string;
  sensitive: boolean;
  providerId: string;
  sideEffects: {
    sideEffectId: string;
    kind: SideEffectKind;
    severity: ImpactSeverity;
    heuristic: boolean;
  }[];
  pathCount: number;
  rules: string[];
};

export type BlastRadiusReport = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-blast-radius";
  tenantId: string;
  agentId: string;
  analyzedAt: string;
  paths: AttackPath[];
  incompletePaths: number;
  resources: BlastRadiusResource[];
  rules: BlastRadiusRule[];
  heuristicNote: string;
};

export type CoverageMetrics = {
  activeAgents: number;
  policyCoveredAgents: number;
  evidenceFreshAgents: number;
  gatewayManagedAgents: number;
  productionProviders: number;
  killSwitchProviders: number;
  directCredentials: number;
  outsideGatewayAgents: number;
  unownedProduction: number;
  policyCoverageBps: number;
  evidenceCoverageBps: number;
  gatewayCoverageBps: number;
  killSwitchCoverageBps: number;
};

export type RemovalAnalysis = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-removal-analysis";
  tenantId: string;
  generatedAt: string;
  basis: "local_inventory_data";
  coverage: CoverageMetrics;
  lostWithoutGhostApi: string[];
};

export type RoiCounterRow = {
  sourceId: string;
  sourceType: ImportSourceType;
  sourceName: string;
  value: number;
};

export type RoiReport = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-roi";
  tenantId: string;
  generatedAt: string;
  basis: "local_inventory_data_only";
  activeAgentCount: number;
  productionProviderCount: number;
  incidents: {
    preventedEgressAttempts: number;
    preventedEgressSources: RoiCounterRow[];
    reviewTimeMinutes: number | null;
    reviewTimeSources: RoiCounterRow[];
    meanTimeToContainMinutes: number | null;
    meanTimeToContainSources: RoiCounterRow[];
  };
  remediationOutcomes: {
    unusedGrantsRemoved: number;
    excessiveScopeReductions: number;
    ownedGrants: number;
    onboardedAgents: number;
    evalsCreated: number;
  };
  coverage: Pick<
    CoverageMetrics,
    | "policyCoverageBps"
    | "evidenceCoverageBps"
    | "gatewayCoverageBps"
    | "killSwitchCoverageBps"
  >;
  notMeasured: string[];
};

export type InventorySnapshot = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-snapshot";
  tenantId: string;
  agents: AgentRecord[];
  tools: ToolRecord[];
  identities: IdentityRecord[];
  providers: ProviderRecord[];
  resources: ResourceRecord[];
  sideEffects: SideEffectRecord[];
  credentials: CredentialRecord[];
  policies: PolicyRecord[];
  edges: GraphEdgeView[];
  findings: FindingRecord[];
  remediations: RemediationRecord[];
  sources: ImportSourceRecord[];
  importRuns: ImportRunRecord[];
};

export type InventoryExport = {
  schemaVersion: 1;
  kind: "ghostapi.inventory-export";
  tenantId: string;
  exportedAt: string;
  inventory: Omit<InventorySnapshot, "schemaVersion" | "kind" | "edges"> & {
    edges: GraphEdgeView[];
  };
  policyRecords: PolicyRecord[];
  scenarioRefs: {
    evalScenarioId: string;
    forFindingId: string;
    createdBy: string;
  }[];
  evidenceMetadata: {
    agentId: string;
    lastEvidenceAt: string | null;
    status: FreshnessStatus;
  }[];
  removalAnalysis: RemovalAnalysis;
  roi: RoiReport;
};

export type ImportSummary = {
  runId: string;
  importedAt: string;
  digest: string;
  recordCounts: ImportRunRecord["recordCounts"];
  edgesCreated: number;
  edgesRefreshed: number;
};

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

export function emptyInventoryState(): InventoryStoreState {
  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory",
    sources: [],
    importRuns: [],
    agents: [],
    tools: [],
    identities: [],
    providers: [],
    resources: [],
    sideEffects: [],
    credentials: [],
    policies: [],
    edges: [],
    findings: [],
    remediations: [],
  };
}

export function sha256Digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalPayloadDigest(
  payload: InventoryImportPayload,
): string {
  return sha256Digest(JSON.stringify(payload, sortedKeysReplacer));
}

export function sortedKeysReplacer(_key: string, value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
  }
  return value;
}

export function validateImportPayload(value: unknown): InventoryImportPayload {
  const payload = object(value, "Inventory import must be an object.");
  exactKeys(
    payload,
    [
      "schemaVersion",
      "kind",
      "source",
      "expectedPolicyHashes",
      "counters",
      "agents",
      "tools",
      "identities",
      "providers",
      "resources",
      "sideEffects",
      "credentials",
      "policies",
    ],
    "inventory import",
    [
      "expectedPolicyHashes",
      "counters",
      "agents",
      "tools",
      "identities",
      "providers",
      "resources",
      "sideEffects",
      "credentials",
      "policies",
    ],
  );
  if (
    payload.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
    payload.kind !== "ghostapi.inventory-import"
  )
    throw new InventoryError("Unsupported inventory import schema.");
  const source = validateImportSource(payload.source);
  if (source.sourceType === "config" && payload.counters !== undefined)
    throw new InventoryError(
      "Counters are only allowed for ci, gateway, or cloud imports.",
    );
  const expectedPolicyHashes =
    payload.expectedPolicyHashes === undefined
      ? []
      : array(payload.expectedPolicyHashes, "expected policy hashes", 64).map(
          validateExpectedPolicyHash,
        );
  const counters =
    payload.counters === undefined
      ? undefined
      : validateCounters(payload.counters);
  const agents =
    payload.agents === undefined
      ? []
      : array(payload.agents, "agents", 200).map(validateImportedAgent);
  const tools =
    payload.tools === undefined
      ? []
      : array(payload.tools, "tools", 200).map(validateImportedTool);
  const identities =
    payload.identities === undefined
      ? []
      : array(payload.identities, "identities", 200).map(
          validateImportedIdentity,
        );
  const providers =
    payload.providers === undefined
      ? []
      : array(payload.providers, "providers", 100).map(
          validateImportedProvider,
        );
  const resources =
    payload.resources === undefined
      ? []
      : array(payload.resources, "resources", 300).map(
          validateImportedResource,
        );
  const sideEffects =
    payload.sideEffects === undefined
      ? []
      : array(payload.sideEffects, "side effects", 400).map(
          validateImportedSideEffect,
        );
  const credentials =
    payload.credentials === undefined
      ? []
      : array(payload.credentials, "credentials", 200).map(
          validateImportedCredential,
        );
  const policies =
    payload.policies === undefined
      ? []
      : array(payload.policies, "policies", 50).map(validateImportedPolicy);
  unique(
    agents.map((agent) => agent.agentId),
    "agent ids",
  );
  unique(
    tools.map((tool) => tool.toolId),
    "tool ids",
  );
  unique(
    identities.map((identity) => identity.identityId),
    "identity ids",
  );
  unique(
    providers.map((provider) => provider.providerId),
    "provider ids",
  );
  unique(
    resources.map((resource) => resource.resourceId),
    "resource ids",
  );
  unique(
    sideEffects.map((sideEffect) => sideEffect.sideEffectId),
    "side effect ids",
  );
  unique(
    credentials.map((credential) => credential.credentialId),
    "credential ids",
  );
  unique(
    policies.map((policy) => policy.policyId),
    "policy ids",
  );
  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory-import",
    source,
    expectedPolicyHashes,
    ...(counters === undefined ? {} : { counters }),
    agents,
    tools,
    identities,
    providers,
    resources,
    sideEffects,
    credentials,
    policies,
  };
}

export function validateState(value: unknown): InventoryStoreState {
  const state = object(value, "Inventory store must be an object.");
  exactKeys(
    state,
    [
      "schemaVersion",
      "kind",
      "sources",
      "importRuns",
      "agents",
      "tools",
      "identities",
      "providers",
      "resources",
      "sideEffects",
      "credentials",
      "policies",
      "edges",
      "findings",
      "remediations",
    ],
    "inventory store",
  );
  if (
    state.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
    state.kind !== INVENTORY_KIND
  )
    throw new InventoryError("Unsupported inventory store schema.");
  const sources = array(
    state.sources,
    "import sources",
    INVENTORY_LIMITS.maxSources,
  ).map(validateSourceRecord);
  const importRuns = array(
    state.importRuns,
    "import runs",
    INVENTORY_LIMITS.maxImports,
  ).map(validateImportRunRecord);
  const agents = array(state.agents, "agents", INVENTORY_LIMITS.maxAgents).map(
    (record) => validateAgentRecord(record),
  );
  const tools = array(state.tools, "tools", INVENTORY_LIMITS.maxTools).map(
    (record) => validateToolRecord(record),
  );
  const identities = array(
    state.identities,
    "identities",
    INVENTORY_LIMITS.maxIdentities,
  ).map((record) => validateIdentityRecord(record));
  const providers = array(
    state.providers,
    "providers",
    INVENTORY_LIMITS.maxProviders,
  ).map((record) => validateProviderRecord(record));
  const resources = array(
    state.resources,
    "resources",
    INVENTORY_LIMITS.maxResources,
  ).map((record) => validateResourceRecord(record));
  const sideEffects = array(
    state.sideEffects,
    "side effects",
    INVENTORY_LIMITS.maxSideEffects,
  ).map((record) => validateSideEffectRecord(record));
  const credentials = array(
    state.credentials,
    "credentials",
    INVENTORY_LIMITS.maxCredentials,
  ).map((record) => validateCredentialRecord(record));
  const policies = array(
    state.policies,
    "policies",
    INVENTORY_LIMITS.maxPolicies,
  ).map((record) => validatePolicyRecord(record));
  const edges = array(
    state.edges,
    "graph edges",
    INVENTORY_LIMITS.maxEdges,
  ).map(validateEdge);
  const findings = array(
    state.findings,
    "findings",
    INVENTORY_LIMITS.maxFindings,
  ).map(validateFindingRecord);
  const remediations = array(
    state.remediations,
    "remediations",
    INVENTORY_LIMITS.maxRemediations,
  ).map(validateRemediationRecord);
  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory",
    sources,
    importRuns,
    agents,
    tools,
    identities,
    providers,
    resources,
    sideEffects,
    credentials,
    policies,
    edges,
    findings,
    remediations,
  };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function validateOperator(value: unknown): InventoryOperator {
  const operator = object(value, "Inventory operator is invalid.");
  exactKeys(
    operator,
    ["id", "principalId", "tenantId", "permissions"],
    "inventory operator",
  );
  const permissions = array(
    operator.permissions,
    "inventory operator permissions",
    8,
  ).map((permission) => {
    if (!isInventoryPermission(permission))
      throw new InventoryError("Inventory operator permission is invalid.");
    return permission as InventoryOperatorPermission;
  });
  unique(permissions, "inventory operator permissions");
  return {
    id: identifier(operator.id, "Inventory operator id"),
    principalId: identifier(
      operator.principalId,
      "Inventory operator principal id",
    ),
    tenantId: identifier(operator.tenantId, "Inventory operator tenant id"),
    permissions,
  };
}

export function validateFindingsAndRemediations(value: unknown): {
  findings: FindingRecord[];
  remediations: RemediationRecord[];
} {
  const box = object(
    value,
    "Inventory findings and remediations must be an object.",
  );
  exactKeys(box, ["findings", "remediations"], "inventory findings box");
  return {
    findings: array(box.findings, "findings", INVENTORY_LIMITS.maxFindings).map(
      validateFindingRecord,
    ),
    remediations: array(
      box.remediations,
      "remediations",
      INVENTORY_LIMITS.maxRemediations,
    ).map(validateRemediationRecord),
  };
}

function isInventoryPermission(
  value: unknown,
): value is InventoryOperatorPermission {
  return (
    value === "inventory.import" ||
    value === "inventory.inspect" ||
    value === "inventory.analyze" ||
    value === "inventory.remediate" ||
    value === "inventory.export"
  );
}

function validateImportSource(
  value: unknown,
): InventoryImportPayload["source"] {
  const source = object(value, "Inventory import source is invalid.");
  exactKeys(
    source,
    ["sourceId", "sourceType", "sourceName", "sourceVersion"],
    "inventory import source",
    ["sourceVersion"],
  );
  const sourceType = source.sourceType;
  if (!IMPORT_SOURCE_TYPES.includes(sourceType as ImportSourceType))
    throw new InventoryError(
      "Inventory import source type must be config, ci, gateway, or cloud.",
    );
  return {
    sourceId: identifier(source.sourceId, "Import source id"),
    sourceType: sourceType as ImportSourceType,
    sourceName: text(source.sourceName, "Import source name", 120),
    ...(source.sourceVersion === undefined
      ? {}
      : {
          sourceVersion: text(
            source.sourceVersion,
            "Import source version",
            64,
          ),
        }),
  };
}

function validateExpectedPolicyHash(value: unknown): ExpectedPolicyHash {
  const expected = object(value, "Expected policy hash is invalid.");
  exactKeys(expected, ["environmentId", "policyHash"], "expected policy hash");
  return {
    environmentId: identifier(expected.environmentId, "Environment id"),
    policyHash: hash(expected.policyHash, "Policy hash"),
  };
}

function validateCounters(value: unknown): ImportCounters {
  const counters = object(value, "Import counters are invalid.");
  exactKeys(
    counters,
    [
      "preventedEgressAttempts",
      "reviewTimeMinutes",
      "meanTimeToContainMinutes",
    ],
    "import counters",
  );
  const result: ImportCounters = {};
  for (const key of [
    "preventedEgressAttempts",
    "reviewTimeMinutes",
    "meanTimeToContainMinutes",
  ] as const) {
    if (counters[key] !== undefined)
      result[key] = nonNegative(
        counters[key],
        `Import counter ${key}`,
        9_999_999_999,
      );
  }
  return result;
}

function validateImportedAgent(value: unknown): ImportedAgent {
  const record = object(value, "Imported agent is invalid.");
  exactKeys(
    record,
    [
      "agentId",
      "name",
      "ownerId",
      "businessPurpose",
      "model",
      "runtime",
      "version",
      "identityIds",
      "environmentIds",
      "gatewayManaged",
      "killSwitchEnabled",
      "lastEvidenceAt",
    ],
    "imported agent",
    [
      "ownerId",
      "businessPurpose",
      "model",
      "runtime",
      "version",
      "lastEvidenceAt",
    ],
  );
  if (
    typeof record.gatewayManaged !== "boolean" ||
    typeof record.killSwitchEnabled !== "boolean"
  )
    throw new InventoryError("Imported agent booleans are invalid.");
  return {
    agentId: identifier(record.agentId, "Agent id"),
    name: text(record.name, "Agent name", 160),
    ...(record.ownerId === undefined
      ? {}
      : { ownerId: identifier(record.ownerId, "Agent owner id") }),
    ...(record.businessPurpose === undefined
      ? {}
      : {
          businessPurpose: text(
            record.businessPurpose,
            "Agent business purpose",
            240,
          ),
        }),
    ...(record.model === undefined
      ? {}
      : { model: text(record.model, "Agent model", 120) }),
    ...(record.runtime === undefined
      ? {}
      : { runtime: text(record.runtime, "Agent runtime", 120) }),
    ...(record.version === undefined
      ? {}
      : { version: text(record.version, "Agent version", 64) }),
    identityIds: identifiers(
      record.identityIds,
      "Agent identity ids",
      INVENTORY_LIMITS.maxReferencesPerRecord,
    ),
    environmentIds: identifiers(
      record.environmentIds,
      "Agent environment ids",
      16,
    ),
    gatewayManaged: record.gatewayManaged,
    killSwitchEnabled: record.killSwitchEnabled,
    ...(record.lastEvidenceAt === undefined
      ? {}
      : {
          lastEvidenceAt: timestamp(
            record.lastEvidenceAt,
            "Agent last evidence time",
          ),
        }),
  };
}

function validateImportedTool(value: unknown): ImportedTool {
  const record = object(value, "Imported tool is invalid.");
  exactKeys(
    record,
    ["toolId", "name", "kind", "providerId", "requiredScopes", "credentialIds"],
    "imported tool",
    ["providerId"],
  );
  const kind = record.kind;
  if (!TOOL_KINDS.includes(kind as ToolKind))
    throw new InventoryError("Imported tool kind is invalid.");
  return {
    toolId: identifier(record.toolId, "Tool id"),
    name: text(record.name, "Tool name", 160),
    kind: kind as ToolKind,
    ...(record.providerId === undefined
      ? {}
      : { providerId: identifier(record.providerId, "Tool provider id") }),
    requiredScopes: scopes(
      record.requiredScopes,
      "Tool required scopes",
      INVENTORY_LIMITS.maxScopesPerRecord,
    ),
    credentialIds: identifiers(
      record.credentialIds,
      "Tool credential ids",
      INVENTORY_LIMITS.maxReferencesPerRecord,
    ),
  };
}

function validateImportedIdentity(value: unknown): ImportedIdentity {
  const record = object(value, "Imported identity is invalid.");
  exactKeys(
    record,
    [
      "identityId",
      "principalId",
      "role",
      "agentId",
      "toolIds",
      "environmentIds",
      "scopes",
    ],
    "imported identity",
    ["agentId"],
  );
  const role = record.role;
  if (!IDENTITY_ROLES.includes(role as IdentityRole))
    throw new InventoryError("Imported identity role is invalid.");
  return {
    identityId: identifier(record.identityId, "Identity id"),
    principalId: identifier(record.principalId, "Identity principal id"),
    role: role as IdentityRole,
    ...(record.agentId === undefined
      ? {}
      : { agentId: identifier(record.agentId, "Identity agent id") }),
    toolIds: identifiers(
      record.toolIds,
      "Identity tool ids",
      INVENTORY_LIMITS.maxReferencesPerRecord,
    ),
    environmentIds: identifiers(
      record.environmentIds,
      "Identity environment ids",
      16,
    ),
    scopes: scopes(
      record.scopes,
      "Identity scopes",
      INVENTORY_LIMITS.maxScopesPerRecord,
    ),
  };
}

function validateImportedProvider(value: unknown): ImportedProvider {
  const record = object(value, "Imported provider is invalid.");
  exactKeys(
    record,
    [
      "providerId",
      "name",
      "providerType",
      "ownerId",
      "environmentIds",
      "resourceIds",
      "gatewayBound",
      "killSwitchApplied",
    ],
    "imported provider",
    ["ownerId"],
  );
  if (
    typeof record.gatewayBound !== "boolean" ||
    typeof record.killSwitchApplied !== "boolean"
  )
    throw new InventoryError("Imported provider booleans are invalid.");
  return {
    providerId: identifier(record.providerId, "Provider id"),
    name: text(record.name, "Provider name", 160),
    providerType: text(record.providerType, "Provider type", 120),
    ...(record.ownerId === undefined
      ? {}
      : { ownerId: identifier(record.ownerId, "Provider owner id") }),
    environmentIds: identifiers(
      record.environmentIds,
      "Provider environment ids",
      16,
    ),
    resourceIds: identifiers(
      record.resourceIds,
      "Provider resource ids",
      INVENTORY_LIMITS.maxReferencesPerRecord,
    ),
    gatewayBound: record.gatewayBound,
    killSwitchApplied: record.killSwitchApplied,
  };
}

function validateImportedResource(value: unknown): ImportedResource {
  const record = object(value, "Imported resource is invalid.");
  exactKeys(
    record,
    [
      "resourceId",
      "providerId",
      "resourceType",
      "name",
      "environmentIds",
      "sensitive",
      "ownerId",
      "businessPurpose",
      "sideEffectIds",
    ],
    "imported resource",
    ["ownerId", "businessPurpose"],
  );
  if (typeof record.sensitive !== "boolean")
    throw new InventoryError("Imported resource sensitive flag is invalid.");
  return {
    resourceId: identifier(record.resourceId, "Resource id"),
    providerId: identifier(record.providerId, "Resource provider id"),
    resourceType: text(record.resourceType, "Resource type", 120),
    name: text(record.name, "Resource name", 160),
    environmentIds: identifiers(
      record.environmentIds,
      "Resource environment ids",
      16,
    ),
    sensitive: record.sensitive,
    ...(record.ownerId === undefined
      ? {}
      : { ownerId: identifier(record.ownerId, "Resource owner id") }),
    ...(record.businessPurpose === undefined
      ? {}
      : {
          businessPurpose: text(
            record.businessPurpose,
            "Resource business purpose",
            240,
          ),
        }),
    sideEffectIds: identifiers(
      record.sideEffectIds,
      "Resource side effect ids",
      INVENTORY_LIMITS.maxReferencesPerRecord,
    ),
  };
}

function validateImportedSideEffect(value: unknown): ImportedSideEffect {
  const record = object(value, "Imported side effect is invalid.");
  exactKeys(
    record,
    ["sideEffectId", "resourceId", "kind", "severity"],
    "imported side effect",
  );
  const kind = record.kind;
  const severity = record.severity;
  if (!SIDE_EFFECT_KINDS.includes(kind as SideEffectKind))
    throw new InventoryError("Imported side effect kind is invalid.");
  if (!IMPACT_SEVERITIES.includes(severity as ImpactSeverity))
    throw new InventoryError("Imported side effect severity is invalid.");
  return {
    sideEffectId: identifier(record.sideEffectId, "Side effect id"),
    resourceId: identifier(record.resourceId, "Side effect resource id"),
    kind: kind as SideEffectKind,
    severity: severity as ImpactSeverity,
  };
}

function validateImportedCredential(value: unknown): ImportedCredential {
  const record = object(value, "Imported credential is invalid.");
  exactKeys(
    record,
    [
      "credentialId",
      "name",
      "providerId",
      "ownerId",
      "environmentIds",
      "grantScopes",
      "toolIds",
      "status",
      "issuedAt",
      "lastUsedAt",
      "rotatedAt",
      "gatewayBound",
    ],
    "imported credential",
    ["ownerId", "lastUsedAt", "rotatedAt"],
  );
  if (record.status !== "active" && record.status !== "revoked")
    throw new InventoryError("Imported credential status is invalid.");
  if (typeof record.gatewayBound !== "boolean")
    throw new InventoryError(
      "Imported credential gatewayBound flag is invalid.",
    );
  return {
    credentialId: identifier(record.credentialId, "Credential id"),
    name: text(record.name, "Credential name", 160),
    providerId: identifier(record.providerId, "Credential provider id"),
    ...(record.ownerId === undefined
      ? {}
      : { ownerId: identifier(record.ownerId, "Credential owner id") }),
    environmentIds: identifiers(
      record.environmentIds,
      "Credential environment ids",
      16,
    ),
    grantScopes: scopes(
      record.grantScopes,
      "Credential grant scopes",
      INVENTORY_LIMITS.maxScopesPerRecord,
    ),
    toolIds: identifiers(
      record.toolIds,
      "Credential tool ids",
      INVENTORY_LIMITS.maxReferencesPerRecord,
    ),
    status: record.status as "active" | "revoked",
    issuedAt: timestamp(record.issuedAt, "Credential issued time"),
    ...(record.lastUsedAt === undefined
      ? {}
      : {
          lastUsedAt: timestamp(record.lastUsedAt, "Credential last used time"),
        }),
    ...(record.rotatedAt === undefined
      ? {}
      : { rotatedAt: timestamp(record.rotatedAt, "Credential rotated time") }),
    gatewayBound: record.gatewayBound,
  };
}

function validateImportedPolicy(value: unknown): ImportedPolicy {
  const record = object(value, "Imported policy is invalid.");
  exactKeys(
    record,
    ["policyId", "name", "version", "hash", "environmentIds"],
    "imported policy",
  );
  return {
    policyId: identifier(record.policyId, "Policy id"),
    name: text(record.name, "Policy name", 160),
    version: text(record.version, "Policy version", 64),
    hash: hash(record.hash, "Policy hash"),
    environmentIds: identifiers(
      record.environmentIds,
      "Policy environment ids",
      16,
    ),
  };
}

function validateSourceRecord(value: unknown): ImportSourceRecord {
  const record = object(value, "Import source is invalid.");
  exactKeys(
    record,
    [
      "tenantId",
      "sourceId",
      "sourceType",
      "sourceName",
      "sourceVersion",
      "firstSeenAt",
      "lastSeenAt",
      "lastDigest",
    ],
    "import source",
    ["sourceVersion"],
  );
  const sourceType = record.sourceType;
  if (!IMPORT_SOURCE_TYPES.includes(sourceType as ImportSourceType))
    throw new InventoryError("Import source type is invalid.");
  return {
    tenantId: identifier(record.tenantId, "Source tenant id"),
    sourceId: identifier(record.sourceId, "Source id"),
    sourceType: sourceType as ImportSourceType,
    sourceName: text(record.sourceName, "Source name", 120),
    ...(record.sourceVersion === undefined
      ? {}
      : { sourceVersion: text(record.sourceVersion, "Source version", 64) }),
    firstSeenAt: timestamp(record.firstSeenAt, "Source first seen time"),
    lastSeenAt: timestamp(record.lastSeenAt, "Source last seen time"),
    lastDigest: hash(record.lastDigest, "Source digest"),
  };
}

function validateImportRunRecord(value: unknown): ImportRunRecord {
  const record = object(value, "Import run is invalid.");
  exactKeys(
    record,
    [
      "schemaVersion",
      "kind",
      "tenantId",
      "runId",
      "importedAt",
      "importedBy",
      "source",
      "digest",
      "expectedPolicyHashes",
      "counters",
      "recordCounts",
      "edgesCreated",
      "edgesRefreshed",
      "status",
    ],
    "import run",
    ["counters"],
  );
  if (
    record.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
    record.kind !== "ghostapi.inventory-import-run"
  )
    throw new InventoryError("Unsupported import run schema.");
  if (record.status !== "completed")
    throw new InventoryError("Import run status is invalid.");
  const source = object(record.source, "Import run source is invalid.");
  exactKeys(
    source,
    ["sourceId", "sourceType", "sourceName", "sourceVersion"],
    "import run source",
    ["sourceVersion"],
  );
  const sourceType = source.sourceType;
  if (!IMPORT_SOURCE_TYPES.includes(sourceType as ImportSourceType))
    throw new InventoryError("Import run source type is invalid.");
  const recordCounts = object(
    record.recordCounts,
    "Import run record counts are invalid.",
  );
  exactKeys(
    recordCounts,
    [
      "agents",
      "tools",
      "identities",
      "providers",
      "resources",
      "sideEffects",
      "credentials",
      "policies",
    ],
    "import run record counts",
  );
  const counters =
    record.counters === undefined
      ? undefined
      : validateCounters(record.counters);
  if (sourceType === "config" && counters !== undefined)
    throw new InventoryError(
      "Counters are only allowed for ci, gateway, or cloud imports.",
    );
  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory-import-run",
    tenantId: identifier(record.tenantId, "Import run tenant id"),
    runId: identifier(record.runId, "Import run id"),
    importedAt: timestamp(record.importedAt, "Import run time"),
    importedBy: identifier(record.importedBy, "Import run importer"),
    source: {
      sourceId: identifier(source.sourceId, "Import run source id"),
      sourceType: sourceType as ImportSourceType,
      sourceName: text(source.sourceName, "Import run source name", 120),
      ...(source.sourceVersion === undefined
        ? {}
        : {
            sourceVersion: text(
              source.sourceVersion,
              "Import run source version",
              64,
            ),
          }),
    },
    digest: hash(record.digest, "Import run digest"),
    expectedPolicyHashes: array(
      record.expectedPolicyHashes,
      "import run expected policy hashes",
      64,
    ).map(validateExpectedPolicyHash),
    ...(counters === undefined ? {} : { counters }),
    recordCounts: {
      agents: nonNegative(recordCounts.agents, "Import run agent count", 500),
      tools: nonNegative(recordCounts.tools, "Import run tool count", 500),
      identities: nonNegative(
        recordCounts.identities,
        "Import run identity count",
        500,
      ),
      providers: nonNegative(
        recordCounts.providers,
        "Import run provider count",
        200,
      ),
      resources: nonNegative(
        recordCounts.resources,
        "Import run resource count",
        1000,
      ),
      sideEffects: nonNegative(
        recordCounts.sideEffects,
        "Import run side effect count",
        2000,
      ),
      credentials: nonNegative(
        recordCounts.credentials,
        "Import run credential count",
        500,
      ),
      policies: nonNegative(
        recordCounts.policies,
        "Import run policy count",
        100,
      ),
    },
    edgesCreated: nonNegative(
      record.edgesCreated,
      "Import run edges created",
      6000,
    ),
    edgesRefreshed: nonNegative(
      record.edgesRefreshed,
      "Import run edges refreshed",
      6000,
    ),
    status: "completed",
  };
}

function validateAgentRecord(value: unknown): AgentRecord {
  const record = object(value, "Agent record is invalid.");
  exactKeys(
    record,
    [
      "schemaVersion",
      "kind",
      "tenantId",
      "agentId",
      "name",
      "ownerId",
      "businessPurpose",
      "model",
      "runtime",
      "version",
      "identityIds",
      "environmentIds",
      "gatewayManaged",
      "killSwitchEnabled",
      "lastEvidenceAt",
      "provenance",
      "freshness",
    ],
    "agent record",
    ["businessPurpose", "model", "runtime", "version"],
  );
  if (
    record.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
    record.kind !== "ghostapi.inventory-agent"
  )
    throw new InventoryError("Unsupported agent record schema.");
  if (
    typeof record.gatewayManaged !== "boolean" ||
    typeof record.killSwitchEnabled !== "boolean"
  )
    throw new InventoryError("Agent record booleans are invalid.");
  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory-agent",
    tenantId: identifier(record.tenantId, "Agent tenant id"),
    agentId: identifier(record.agentId, "Agent id"),
    name: text(record.name, "Agent name", 160),
    ownerId:
      record.ownerId === null
        ? null
        : record.ownerId === undefined
          ? null
          : identifier(record.ownerId, "Agent owner id"),
    ...(record.businessPurpose === undefined
      ? {}
      : {
          businessPurpose: text(
            record.businessPurpose,
            "Agent business purpose",
            240,
          ),
        }),
    ...(record.model === undefined
      ? {}
      : { model: text(record.model, "Agent model", 120) }),
    ...(record.runtime === undefined
      ? {}
      : { runtime: text(record.runtime, "Agent runtime", 120) }),
    ...(record.version === undefined
      ? {}
      : { version: text(record.version, "Agent version", 64) }),
    identityIds: identifiers(
      record.identityIds,
      "Agent identity ids",
      INVENTORY_LIMITS.maxReferencesPerRecord,
    ),
    environmentIds: identifiers(
      record.environmentIds,
      "Agent environment ids",
      16,
    ),
    gatewayManaged: record.gatewayManaged,
    killSwitchEnabled: record.killSwitchEnabled,
    lastEvidenceAt:
      record.lastEvidenceAt === null
        ? null
        : record.lastEvidenceAt === undefined
          ? null
          : timestamp(record.lastEvidenceAt, "Agent last evidence time"),
    provenance: validateProvenance(record.provenance),
    freshness: validateFreshness(record.freshness),
  };
}

function validateToolRecord(value: unknown): ToolRecord {
  const record = object(value, "Tool record is invalid.");
  exactKeys(
    record,
    [
      "schemaVersion",
      "kind",
      "tenantId",
      "toolId",
      "name",
      "providerId",
      "requiredScopes",
      "credentialIds",
      "provenance",
      "freshness",
    ],
    "tool record",
    ["providerId"],
  );
  if (record.schemaVersion !== INVENTORY_SCHEMA_VERSION)
    throw new InventoryError("Unsupported tool record schema.");
  const toolKind = record.kind;
  if (!TOOL_KINDS.includes(toolKind as ToolKind))
    throw new InventoryError("Tool record kind is invalid.");
  return {
    schemaVersion: 1,
    tenantId: identifier(record.tenantId, "Tool tenant id"),
    toolId: identifier(record.toolId, "Tool id"),
    name: text(record.name, "Tool name", 160),
    kind: toolKind as ToolKind,
    providerId:
      record.providerId === null
        ? null
        : record.providerId === undefined
          ? null
          : identifier(record.providerId, "Tool provider id"),
    requiredScopes: scopes(
      record.requiredScopes,
      "Tool required scopes",
      INVENTORY_LIMITS.maxScopesPerRecord,
    ),
    credentialIds: identifiers(
      record.credentialIds,
      "Tool credential ids",
      INVENTORY_LIMITS.maxReferencesPerRecord,
    ),
    provenance: validateProvenance(record.provenance),
    freshness: validateFreshness(record.freshness),
  };
}

function validateIdentityRecord(value: unknown): IdentityRecord {
  const record = object(value, "Identity record is invalid.");
  exactKeys(
    record,
    [
      "schemaVersion",
      "kind",
      "tenantId",
      "identityId",
      "principalId",
      "role",
      "agentId",
      "toolIds",
      "environmentIds",
      "scopes",
      "provenance",
      "freshness",
    ],
    "identity record",
    ["agentId"],
  );
  if (
    record.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
    record.kind !== "ghostapi.inventory-identity"
  )
    throw new InventoryError("Unsupported identity record schema.");
  const role = record.role;
  if (!IDENTITY_ROLES.includes(role as IdentityRole))
    throw new InventoryError("Identity record role is invalid.");
  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory-identity",
    tenantId: identifier(record.tenantId, "Identity tenant id"),
    identityId: identifier(record.identityId, "Identity id"),
    principalId: identifier(record.principalId, "Identity principal id"),
    role: role as IdentityRole,
    agentId:
      record.agentId === null
        ? null
        : record.agentId === undefined
          ? null
          : identifier(record.agentId, "Identity agent id"),
    toolIds: identifiers(
      record.toolIds,
      "Identity tool ids",
      INVENTORY_LIMITS.maxReferencesPerRecord,
    ),
    environmentIds: identifiers(
      record.environmentIds,
      "Identity environment ids",
      16,
    ),
    scopes: scopes(
      record.scopes,
      "Identity scopes",
      INVENTORY_LIMITS.maxScopesPerRecord,
    ),
    provenance: validateProvenance(record.provenance),
    freshness: validateFreshness(record.freshness),
  };
}

function validateProviderRecord(value: unknown): ProviderRecord {
  const record = object(value, "Provider record is invalid.");
  exactKeys(
    record,
    [
      "schemaVersion",
      "kind",
      "tenantId",
      "providerId",
      "name",
      "providerType",
      "ownerId",
      "environmentIds",
      "resourceIds",
      "gatewayBound",
      "killSwitchApplied",
      "provenance",
      "freshness",
    ],
    "provider record",
    ["ownerId"],
  );
  if (
    record.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
    record.kind !== "ghostapi.inventory-provider"
  )
    throw new InventoryError("Unsupported provider record schema.");
  if (
    typeof record.gatewayBound !== "boolean" ||
    typeof record.killSwitchApplied !== "boolean"
  )
    throw new InventoryError("Provider record booleans are invalid.");
  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory-provider",
    tenantId: identifier(record.tenantId, "Provider tenant id"),
    providerId: identifier(record.providerId, "Provider id"),
    name: text(record.name, "Provider name", 160),
    providerType: text(record.providerType, "Provider type", 120),
    ownerId:
      record.ownerId === null
        ? null
        : record.ownerId === undefined
          ? null
          : identifier(record.ownerId, "Provider owner id"),
    environmentIds: identifiers(
      record.environmentIds,
      "Provider environment ids",
      16,
    ),
    resourceIds: identifiers(
      record.resourceIds,
      "Provider resource ids",
      INVENTORY_LIMITS.maxReferencesPerRecord,
    ),
    gatewayBound: record.gatewayBound,
    killSwitchApplied: record.killSwitchApplied,
    provenance: validateProvenance(record.provenance),
    freshness: validateFreshness(record.freshness),
  };
}

function validateResourceRecord(value: unknown): ResourceRecord {
  const record = object(value, "Resource record is invalid.");
  exactKeys(
    record,
    [
      "schemaVersion",
      "kind",
      "tenantId",
      "resourceId",
      "providerId",
      "resourceType",
      "name",
      "environmentIds",
      "sensitive",
      "ownerId",
      "businessPurpose",
      "sideEffectIds",
      "provenance",
      "freshness",
    ],
    "resource record",
    ["ownerId", "businessPurpose"],
  );
  if (
    record.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
    record.kind !== "ghostapi.inventory-resource"
  )
    throw new InventoryError("Unsupported resource record schema.");
  if (typeof record.sensitive !== "boolean")
    throw new InventoryError("Resource record sensitive flag is invalid.");
  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory-resource",
    tenantId: identifier(record.tenantId, "Resource tenant id"),
    resourceId: identifier(record.resourceId, "Resource id"),
    providerId: identifier(record.providerId, "Resource provider id"),
    resourceType: text(record.resourceType, "Resource type", 120),
    name: text(record.name, "Resource name", 160),
    environmentIds: identifiers(
      record.environmentIds,
      "Resource environment ids",
      16,
    ),
    sensitive: record.sensitive,
    ownerId:
      record.ownerId === null
        ? null
        : record.ownerId === undefined
          ? null
          : identifier(record.ownerId, "Resource owner id"),
    ...(record.businessPurpose === undefined
      ? {}
      : {
          businessPurpose: text(
            record.businessPurpose,
            "Resource business purpose",
            240,
          ),
        }),
    sideEffectIds: identifiers(
      record.sideEffectIds,
      "Resource side effect ids",
      INVENTORY_LIMITS.maxReferencesPerRecord,
    ),
    provenance: validateProvenance(record.provenance),
    freshness: validateFreshness(record.freshness),
  };
}

function validateSideEffectRecord(value: unknown): SideEffectRecord {
  const record = object(value, "Side effect record is invalid.");
  exactKeys(
    record,
    [
      "schemaVersion",
      "tenantId",
      "sideEffectId",
      "resourceId",
      "kind",
      "severity",
      "provenance",
      "freshness",
    ],
    "side effect record",
  );
  if (record.schemaVersion !== INVENTORY_SCHEMA_VERSION)
    throw new InventoryError("Unsupported side effect record schema.");
  const kind = record.kind;
  const severity = record.severity;
  if (!SIDE_EFFECT_KINDS.includes(kind as SideEffectKind))
    throw new InventoryError("Side effect record kind is invalid.");
  if (!IMPACT_SEVERITIES.includes(severity as ImpactSeverity))
    throw new InventoryError("Side effect record severity is invalid.");
  return {
    schemaVersion: 1,
    tenantId: identifier(record.tenantId, "Side effect tenant id"),
    sideEffectId: identifier(record.sideEffectId, "Side effect id"),
    resourceId: identifier(record.resourceId, "Side effect resource id"),
    kind: kind as SideEffectKind,
    severity: severity as ImpactSeverity,
    provenance: validateProvenance(record.provenance),
    freshness: validateFreshness(record.freshness),
  };
}

function validateCredentialRecord(value: unknown): CredentialRecord {
  const record = object(value, "Credential record is invalid.");
  exactKeys(
    record,
    [
      "schemaVersion",
      "kind",
      "tenantId",
      "credentialId",
      "name",
      "providerId",
      "ownerId",
      "environmentIds",
      "grantScopes",
      "toolIds",
      "status",
      "issuedAt",
      "lastUsedAt",
      "rotatedAt",
      "gatewayBound",
      "provenance",
      "freshness",
    ],
    "credential record",
    ["ownerId", "lastUsedAt", "rotatedAt"],
  );
  if (
    record.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
    record.kind !== "ghostapi.inventory-credential"
  )
    throw new InventoryError("Unsupported credential record schema.");
  if (record.status !== "active" && record.status !== "revoked")
    throw new InventoryError("Credential record status is invalid.");
  if (typeof record.gatewayBound !== "boolean")
    throw new InventoryError("Credential record gatewayBound flag is invalid.");
  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory-credential",
    tenantId: identifier(record.tenantId, "Credential tenant id"),
    credentialId: identifier(record.credentialId, "Credential id"),
    name: text(record.name, "Credential name", 160),
    providerId: identifier(record.providerId, "Credential provider id"),
    ownerId:
      record.ownerId === null
        ? null
        : record.ownerId === undefined
          ? null
          : identifier(record.ownerId, "Credential owner id"),
    environmentIds: identifiers(
      record.environmentIds,
      "Credential environment ids",
      16,
    ),
    grantScopes: scopes(
      record.grantScopes,
      "Credential grant scopes",
      INVENTORY_LIMITS.maxScopesPerRecord,
    ),
    toolIds: identifiers(
      record.toolIds,
      "Credential tool ids",
      INVENTORY_LIMITS.maxReferencesPerRecord,
    ),
    status: record.status as "active" | "revoked",
    issuedAt: timestamp(record.issuedAt, "Credential issued time"),
    lastUsedAt:
      record.lastUsedAt === null
        ? null
        : record.lastUsedAt === undefined
          ? null
          : timestamp(record.lastUsedAt, "Credential last used time"),
    ...(record.rotatedAt === undefined
      ? {}
      : { rotatedAt: timestamp(record.rotatedAt, "Credential rotated time") }),
    gatewayBound: record.gatewayBound,
    provenance: validateProvenance(record.provenance),
    freshness: validateFreshness(record.freshness),
  };
}

function validatePolicyRecord(value: unknown): PolicyRecord {
  const record = object(value, "Policy record is invalid.");
  exactKeys(
    record,
    [
      "schemaVersion",
      "kind",
      "tenantId",
      "policyId",
      "name",
      "version",
      "hash",
      "environmentIds",
      "provenance",
      "freshness",
    ],
    "policy record",
  );
  if (
    record.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
    record.kind !== "ghostapi.inventory-policy"
  )
    throw new InventoryError("Unsupported policy record schema.");
  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory-policy",
    tenantId: identifier(record.tenantId, "Policy tenant id"),
    policyId: identifier(record.policyId, "Policy id"),
    name: text(record.name, "Policy name", 160),
    version: text(record.version, "Policy version", 64),
    hash: hash(record.hash, "Policy hash"),
    environmentIds: identifiers(
      record.environmentIds,
      "Policy environment ids",
      16,
    ),
    provenance: validateProvenance(record.provenance),
    freshness: validateFreshness(record.freshness),
  };
}

function validateEdge(value: unknown): GraphEdge {
  const record = object(value, "Graph edge is invalid.");
  exactKeys(
    record,
    [
      "tenantId",
      "edgeId",
      "sourceKind",
      "sourceId",
      "targetKind",
      "targetId",
      "relation",
      "provenance",
      "firstSeenAt",
      "lastSeenAt",
    ],
    "graph edge",
  );
  if (!NODE_KINDS.includes(record.sourceKind as NodeKind))
    throw new InventoryError("Graph edge source kind is invalid.");
  if (!NODE_KINDS.includes(record.targetKind as NodeKind))
    throw new InventoryError("Graph edge target kind is invalid.");
  if (!EDGE_RELATIONS.includes(record.relation as EdgeRelation))
    throw new InventoryError("Graph edge relation is invalid.");
  return {
    tenantId: identifier(record.tenantId, "Edge tenant id"),
    edgeId: identifier(record.edgeId, "Edge id"),
    sourceKind: record.sourceKind as NodeKind,
    sourceId: identifier(record.sourceId, "Edge source id"),
    targetKind: record.targetKind as NodeKind,
    targetId: identifier(record.targetId, "Edge target id"),
    relation: record.relation as EdgeRelation,
    provenance: validateProvenance(record.provenance),
    firstSeenAt: timestamp(record.firstSeenAt, "Edge first seen time"),
    lastSeenAt: timestamp(record.lastSeenAt, "Edge last seen time"),
  };
}

function validateFindingRecord(value: unknown): FindingRecord {
  const record = object(value, "Finding record is invalid.");
  exactKeys(
    record,
    [
      "schemaVersion",
      "tenantId",
      "findingId",
      "kind",
      "severity",
      "targetKind",
      "targetId",
      "ruleId",
      "reason",
      "basis",
      "discoveredAt",
      "status",
      "resolvedAt",
      "remediationId",
    ],
    "finding record",
    ["resolvedAt", "remediationId"],
  );
  if (record.schemaVersion !== INVENTORY_SCHEMA_VERSION)
    throw new InventoryError("Unsupported finding record schema.");
  if (!FINDING_KINDS.includes(record.kind as FindingKind))
    throw new InventoryError("Finding kind is invalid.");
  if (!FINDING_SEVERITIES.includes(record.severity as FindingSeverity))
    throw new InventoryError("Finding severity is invalid.");
  if (!FINDING_BASIS.includes(record.basis as FindingBasis))
    throw new InventoryError("Finding basis is invalid.");
  if (record.status !== "open" && record.status !== "resolved")
    throw new InventoryError("Finding status is invalid.");
  if (
    record.targetKind !== "agent" &&
    record.targetKind !== "identity" &&
    record.targetKind !== "tool" &&
    record.targetKind !== "provider" &&
    record.targetKind !== "resource" &&
    record.targetKind !== "side_effect" &&
    record.targetKind !== "credential" &&
    record.targetKind !== "environment" &&
    record.targetKind !== "policy"
  )
    throw new InventoryError("Finding target kind is invalid.");
  return {
    schemaVersion: 1,
    tenantId: identifier(record.tenantId, "Finding tenant id"),
    findingId: identifier(record.findingId, "Finding id"),
    kind: record.kind as FindingKind,
    severity: record.severity as FindingSeverity,
    targetKind: record.targetKind as FindingRecord["targetKind"],
    targetId: identifier(record.targetId, "Finding target id"),
    ruleId: identifier(record.ruleId, "Finding rule id"),
    reason: text(record.reason, "Finding reason", 400),
    basis: record.basis as FindingBasis,
    discoveredAt: timestamp(record.discoveredAt, "Finding discovery time"),
    status: record.status as "open" | "resolved",
    ...(record.resolvedAt === undefined
      ? {}
      : { resolvedAt: timestamp(record.resolvedAt, "Finding resolved time") }),
    ...(record.remediationId === undefined
      ? {}
      : {
          remediationId: identifier(
            record.remediationId,
            "Finding remediation id",
          ),
        }),
  };
}

function validateRemediationRecord(value: unknown): RemediationRecord {
  const record = object(value, "Remediation record is invalid.");
  exactKeys(
    record,
    [
      "schemaVersion",
      "tenantId",
      "remediationId",
      "findingId",
      "kind",
      "targetKind",
      "targetId",
      "rationale",
      "proposedBy",
      "createdAt",
      "status",
      "appliedAt",
      "result",
    ],
    "remediation record",
    ["appliedAt", "result"],
  );
  if (record.schemaVersion !== INVENTORY_SCHEMA_VERSION)
    throw new InventoryError("Unsupported remediation record schema.");
  if (!REMEDIATION_KINDS.includes(record.kind as RemediationKind))
    throw new InventoryError("Remediation kind is invalid.");
  if (!REMEDIATION_STATUSES.includes(record.status as RemediationStatus))
    throw new InventoryError("Remediation status is invalid.");
  if (
    record.targetKind !== "agent" &&
    record.targetKind !== "identity" &&
    record.targetKind !== "tool" &&
    record.targetKind !== "provider" &&
    record.targetKind !== "resource" &&
    record.targetKind !== "side_effect" &&
    record.targetKind !== "credential" &&
    record.targetKind !== "environment" &&
    record.targetKind !== "policy"
  )
    throw new InventoryError("Remediation target kind is invalid.");
  const result =
    record.result === undefined
      ? undefined
      : validateRemediationResult(record.result);
  return {
    schemaVersion: 1,
    tenantId: identifier(record.tenantId, "Remediation tenant id"),
    remediationId: identifier(record.remediationId, "Remediation id"),
    findingId: identifier(record.findingId, "Remediation finding id"),
    kind: record.kind as RemediationKind,
    targetKind: record.targetKind as RemediationRecord["targetKind"],
    targetId: identifier(record.targetId, "Remediation target id"),
    rationale: text(record.rationale, "Remediation rationale", 400),
    proposedBy: identifier(record.proposedBy, "Remediation proposer"),
    createdAt: timestamp(record.createdAt, "Remediation creation time"),
    status: record.status as RemediationStatus,
    ...(record.appliedAt === undefined
      ? {}
      : { appliedAt: timestamp(record.appliedAt, "Remediation applied time") }),
    ...(result === undefined ? {} : { result }),
  };
}

function validateRemediationResult(
  value: unknown,
): NonNullable<RemediationRecord["result"]> {
  const result = object(value, "Remediation result is invalid.");
  exactKeys(
    result,
    ["description", "reducedScopes", "evalScenarioId", "ownerId"],
    "remediation result",
    ["reducedScopes", "evalScenarioId", "ownerId"],
  );
  return {
    description: text(
      result.description,
      "Remediation result description",
      400,
    ),
    ...(result.reducedScopes === undefined
      ? {}
      : {
          reducedScopes: scopes(
            result.reducedScopes,
            "Remediation reduced scopes",
            INVENTORY_LIMITS.maxScopesPerRecord,
          ),
        }),
    ...(result.evalScenarioId === undefined
      ? {}
      : {
          evalScenarioId: identifier(
            result.evalScenarioId,
            "Remediation eval scenario id",
          ),
        }),
    ...(result.ownerId === undefined
      ? {}
      : { ownerId: identifier(result.ownerId, "Remediation owner id") }),
  };
}

function validateProvenance(value: unknown): RecordProvenance {
  const provenance = object(value, "Record provenance is invalid.");
  exactKeys(
    provenance,
    ["sourceId", "sourceType", "sourceName", "importedAt", "importedBy"],
    "record provenance",
  );
  const sourceType = provenance.sourceType;
  if (!IMPORT_SOURCE_TYPES.includes(sourceType as ImportSourceType))
    throw new InventoryError("Record provenance source type is invalid.");
  return {
    sourceId: identifier(provenance.sourceId, "Provenance source id"),
    sourceType: sourceType as ImportSourceType,
    sourceName: text(provenance.sourceName, "Provenance source name", 120),
    importedAt: timestamp(provenance.importedAt, "Provenance import time"),
    importedBy: identifier(provenance.importedBy, "Provenance importer"),
  };
}

function validateFreshness(value: unknown): RecordFreshness {
  const freshness = object(value, "Record freshness is invalid.");
  exactKeys(freshness, ["firstSeenAt", "lastSeenAt"], "record freshness");
  return {
    firstSeenAt: timestamp(freshness.firstSeenAt, "Record first seen time"),
    lastSeenAt: timestamp(freshness.lastSeenAt, "Record last seen time"),
  };
}

export function buildRecordProvenance(
  source: InventoryImportPayload["source"],
  importedAt: string,
  importedBy: string,
): RecordProvenance {
  return {
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    sourceName: source.sourceName,
    importedAt,
    importedBy,
  };
}

export function buildRecordFreshness(now: string): RecordFreshness {
  return { firstSeenAt: now, lastSeenAt: now };
}

export function edgeIdFor(
  sourceKind: NodeKind,
  sourceId: string,
  targetKind: NodeKind,
  targetId: string,
  relation: EdgeRelation,
): string {
  return `edge-${sha256Digest(`${sourceKind}:${sourceId}:${targetKind}:${targetId}:${relation}`).slice(0, 40)}`;
}

export function freshnessStatusFor(
  lastSeenAt: string,
  now: string,
  staleDays: number,
): FreshnessStatus {
  const ageDays =
    (Date.parse(now) - Date.parse(lastSeenAt)) / (24 * 60 * 60 * 1000);
  return ageDays <= staleDays ? "fresh" : "stale";
}

export function daysSince(thenIso: string, nowIso: string): number {
  return Math.max(
    0,
    Math.floor(
      (Date.parse(nowIso) - Date.parse(thenIso)) / (24 * 60 * 60 * 1000),
    ),
  );
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new InventoryError(message);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new InventoryError(`${label} is invalid.`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
  optional: string[] = [],
): void {
  for (const key of Object.keys(value)) {
    if (
      !keys.includes(key) ||
      (value[key] === undefined && !optional.includes(key))
    )
      throw new InventoryError(`${label} contains unsupported field: ${key}`);
  }
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new InventoryError(`${label} must be unique.`);
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !IDENTIFIER.test(value) ||
    sanitizeSecretString(value) !== value
  )
    throw new InventoryError(`${label} must be a safe identifier.`);
  return value;
}

function identifiers(value: unknown, label: string, max: number): string[] {
  return array(value, label, max).map((entry) => identifier(entry, label));
}

function scopes(value: unknown, label: string, max: number): string[] {
  return array(value, label, max).map((entry) => {
    if (
      typeof entry !== "string" ||
      !SCOPE_IDENTIFIER.test(entry) ||
      sanitizeSecretString(entry) !== entry
    )
      throw new InventoryError(`${label} must be safe scope identifiers.`);
    return entry;
  });
}

function text(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value) ||
    sanitizeSecretString(value) !== value
  )
    throw new InventoryError(`${label} is invalid.`);
  return value.trim();
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new InventoryError(`${label} must be an ISO UTC timestamp.`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value))
    throw new InventoryError(`${label} must be a sha256 hash.`);
  return value;
}

function nonNegative(value: unknown, label: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new InventoryError(`${label} is invalid.`);
  return value;
}
