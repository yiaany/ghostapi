import {
  type AttackPath,
  type AttackPathResult,
  type BlastRadiusReport,
  type BlastRadiusResource,
  type BlastRadiusRule,
  type CoverageMetrics,
  type FindingRecord,
  type FindingSeverity,
  type GraphEdgeView,
  type ImportRunRecord,
  type InventoryFreshnessDays,
  type InventoryStoreState,
  type NodeKind,
  type RemovalAnalysis,
  type RoiCounterRow,
  type RoiReport,
  freshnessStatusFor,
  FRESHNESS_DEFAULT_DAYS,
  sha256Digest,
} from "./types.js";

const PRODUCTION_ENVIRONMENT = "production";

type FindingKey = `${string}:${string}:${string}`;

export function normalizeFreshnessDays(
  days: InventoryFreshnessDays | undefined,
): Required<InventoryFreshnessDays> {
  return {
    edgeStaleDays: days?.edgeStaleDays ?? FRESHNESS_DEFAULT_DAYS.edgeStale,
    credentialStaleDays:
      days?.credentialStaleDays ?? FRESHNESS_DEFAULT_DAYS.credentialStale,
    evidenceFreshDays:
      days?.evidenceFreshDays ?? FRESHNESS_DEFAULT_DAYS.evidenceFresh,
  };
}

export function graphEdges(
  state: InventoryStoreState,
  tenantId: string,
  now: string,
  freshnessDays: InventoryFreshnessDays | undefined,
): GraphEdgeView[] {
  const normalized = normalizeFreshnessDays(freshnessDays);
  return state.edges
    .filter((edge) => edge.tenantId === tenantId)
    .map((edge) => ({
      ...edge,
      freshnessStatus: freshnessStatusFor(
        edge.lastSeenAt,
        now,
        normalized.edgeStaleDays,
      ),
    }));
}

export function findAttackPaths(
  state: InventoryStoreState,
  tenantId: string,
  agentId: string,
  now: string,
  freshnessDays: InventoryFreshnessDays | undefined,
): AttackPathResult {
  const agent = state.agents.find(
    (candidate) =>
      candidate.tenantId === tenantId && candidate.agentId === agentId,
  );
  if (agent === undefined) return { agentId, paths: [], incompletePaths: 0 };
  const normalized = normalizeFreshnessDays(freshnessDays);
  const staleBeforeMs =
    Date.parse(now) - normalized.edgeStaleDays * 24 * 60 * 60 * 1000;
  const identities = state.identities.filter(
    (identity) => identity.tenantId === tenantId,
  );
  const tools = state.tools.filter((tool) => tool.tenantId === tenantId);
  const providers = state.providers.filter(
    (provider) => provider.tenantId === tenantId,
  );
  const resources = state.resources.filter(
    (resource) => resource.tenantId === tenantId,
  );
  const sideEffects = state.sideEffects.filter(
    (sideEffect) => sideEffect.tenantId === tenantId,
  );
  const edges = state.edges.filter(
    (edge) =>
      edge.tenantId === tenantId &&
      Date.parse(edge.lastSeenAt) >= staleBeforeMs,
  );
  const paths: AttackPath[] = [];
  let incompletePaths = 0;

  for (const identityId of agent.identityIds) {
    const identity = identities.find(
      (candidate) => candidate.identityId === identityId,
    );
    const identityStep = {
      kind: "identity" as const,
      id: identityId,
      display:
        identity === undefined
          ? identityId
          : `${identity.principalId} (${identity.role})`,
    };
    if (identity === undefined) {
      paths.push({
        steps: [stepAgent(agentId), identityStep],
        complete: false,
        edges: [],
      });
      incompletePaths += 1;
      continue;
    }
    for (const toolId of identity.toolIds) {
      const tool = tools.find((candidate) => candidate.toolId === toolId);
      const toolStep = {
        kind: "tool" as const,
        id: toolId,
        display: tool === undefined ? toolId : tool.name,
      };
      const identityEdge = edge(edges, "identity", identityId, "tool", toolId);
      if (tool === undefined || tool.providerId === null) {
        paths.push({
          steps: [stepAgent(agentId), identityStep, toolStep],
          complete: false,
          edges: identityEdge === undefined ? [] : [identityEdge],
        });
        incompletePaths += 1;
        continue;
      }
      const provider = providers.find(
        (candidate) => candidate.providerId === tool.providerId!,
      );
      const providerStep = {
        kind: "provider" as const,
        id: tool.providerId,
        display: provider === undefined ? tool.providerId : provider.name,
      };
      const toolEdge = edge(edges, "tool", toolId, "provider", tool.providerId);
      if (provider === undefined) {
        paths.push({
          steps: [stepAgent(agentId), identityStep, toolStep, providerStep],
          complete: false,
          edges: [identityEdge, toolEdge].filter(
            (candidate): candidate is NonNullable<typeof identityEdge> =>
              candidate !== undefined,
          ),
        });
        incompletePaths += 1;
        continue;
      }
      for (const resourceId of provider.resourceIds) {
        const resource = resources.find(
          (candidate) => candidate.resourceId === resourceId,
        );
        const resourceStep = {
          kind: "resource" as const,
          id: resourceId,
          display: resource === undefined ? resourceId : resource.name,
        };
        const exposeEdge = edge(
          edges,
          "provider",
          provider.providerId,
          "resource",
          resourceId,
        );
        if (resource === undefined) {
          paths.push({
            steps: [
              stepAgent(agentId),
              identityStep,
              toolStep,
              providerStep,
              resourceStep,
            ],
            complete: false,
            edges: [identityEdge, toolEdge, exposeEdge].filter(
              (candidate): candidate is NonNullable<typeof identityEdge> =>
                candidate !== undefined,
            ),
          });
          incompletePaths += 1;
          continue;
        }
        for (const sideEffectId of resource.sideEffectIds) {
          const sideEffect = sideEffects.find(
            (candidate) => candidate.sideEffectId === sideEffectId,
          );
          const sideEffectStep = {
            kind: "side_effect" as const,
            id: sideEffectId,
            display: sideEffect === undefined ? sideEffectId : sideEffect.kind,
          };
          const permitEdge = edge(
            edges,
            "resource",
            resourceId,
            "side_effect",
            sideEffectId,
          );
          if (sideEffect === undefined) {
            paths.push({
              steps: [
                stepAgent(agentId),
                identityStep,
                toolStep,
                providerStep,
                resourceStep,
                sideEffectStep,
              ],
              complete: false,
              edges: [identityEdge, toolEdge, exposeEdge, permitEdge].filter(
                (candidate): candidate is NonNullable<typeof identityEdge> =>
                  candidate !== undefined,
              ),
            });
            incompletePaths += 1;
            continue;
          }
          const usedEdges = [
            identityEdge,
            toolEdge,
            exposeEdge,
            permitEdge,
          ].filter(
            (candidate): candidate is NonNullable<typeof identityEdge> =>
              candidate !== undefined,
          );
          paths.push({
            steps: [
              stepAgent(agentId),
              identityStep,
              toolStep,
              providerStep,
              resourceStep,
              sideEffectStep,
            ],
            complete: true,
            edges: usedEdges,
          });
        }
      }
    }
  }
  return { agentId, paths, incompletePaths };
}

function stepAgent(agentId: string): {
  kind: "agent";
  id: string;
  display: string;
} {
  return { kind: "agent", id: agentId, display: agentId };
}

function edge(
  edges: InventoryStoreState["edges"],
  sourceKind: NodeKind,
  sourceId: string,
  targetKind: NodeKind,
  targetId: string,
): InventoryStoreState["edges"][number] | undefined {
  return edges.find(
    (candidate) =>
      candidate.sourceKind === sourceKind &&
      candidate.sourceId === sourceId &&
      candidate.targetKind === targetKind &&
      candidate.targetId === targetId,
  );
}

export function computeBlastRadius(
  state: InventoryStoreState,
  tenantId: string,
  agentId: string,
  now: string,
  freshnessDays: InventoryFreshnessDays | undefined,
): BlastRadiusReport {
  const result = findAttackPaths(state, tenantId, agentId, now, freshnessDays);
  const resources = state.resources.filter(
    (resource) => resource.tenantId === tenantId,
  );
  const sideEffects = state.sideEffects.filter(
    (sideEffect) => sideEffect.tenantId === tenantId,
  );
  const identities = state.identities.filter(
    (identity) => identity.tenantId === tenantId,
  );
  const tools = state.tools.filter((tool) => tool.tenantId === tenantId);
  const credentials = state.credentials.filter(
    (credential) => credential.tenantId === tenantId,
  );
  const providers = state.providers.filter(
    (provider) => provider.tenantId === tenantId,
  );
  const byResource = new Map<string, BlastRadiusResource>();
  const rules: BlastRadiusRule[] = [];
  const ruleIds = new Set<string>();

  for (const path of result.paths) {
    if (!path.complete || path.steps.length < 6) continue;
    const [
      agentStep,
      identityStep,
      toolStep,
      providerStep,
      resourceStep,
      sideEffectStep,
    ] = path.steps;
    const resource = resources.find(
      (candidate) => candidate.resourceId === resourceStep.id,
    );
    const sideEffect = sideEffects.find(
      (candidate) => candidate.sideEffectId === sideEffectStep.id,
    );
    if (resource === undefined || sideEffect === undefined) continue;
    const identity = identities.find(
      (candidate) => candidate.identityId === identityStep.id,
    );
    const tool = tools.find((candidate) => candidate.toolId === toolStep.id);
    const provider = providers.find(
      (candidate) => candidate.providerId === providerStep.id,
    );
    const credential = credentials.find((candidate) =>
      candidate.toolIds.includes(toolStep.id),
    );

    const rulesForResource: string[] = [];
    const ruleId = `blast.${resourceStep.id}.${sideEffectStep.id}`;
    if (!ruleIds.has(ruleId)) {
      const credentialScopeNote =
        credential === undefined
          ? "no tracked credential bound to the tool"
          : `credential ${credential.credentialId} grants [${credential.grantScopes.join(", ")}]`;
      const explanation = `Agent ${agentStep.id} uses identity ${identityStep.id}${identity === undefined ? "" : ` (${identity.role}, scopes [${identity.scopes.join(", ")}])`} to reach tool ${toolStep.id}${tool === undefined ? "" : ` (${tool.name})`}, which connects to provider ${providerStep.id}${provider === undefined ? "" : ` (${provider.name})`} using ${credentialScopeNote}, exposing resource ${resourceStep.id}, which permits side effect ${sideEffectStep.id} (${sideEffect.kind}, severity ${sideEffect.severity}).`;
      rules.push({ ruleId, explanation });
      ruleIds.add(ruleId);
    }
    rulesForResource.push(ruleId);

    const existing = byResource.get(resourceStep.id);
    if (existing === undefined) {
      byResource.set(resourceStep.id, {
        resourceId: resourceStep.id,
        resourceType: resource.resourceType,
        sensitive: resource.sensitive,
        providerId: providerStep.id,
        sideEffects: [
          {
            sideEffectId: sideEffectStep.id,
            kind: sideEffect.kind,
            severity: sideEffect.severity,
            heuristic: true,
          },
        ],
        pathCount: 1,
        rules: rulesForResource,
      });
    } else {
      existing.pathCount += 1;
      if (
        !existing.sideEffects.some(
          (candidate) => candidate.sideEffectId === sideEffectStep.id,
        )
      ) {
        existing.sideEffects.push({
          sideEffectId: sideEffectStep.id,
          kind: sideEffect.kind,
          severity: sideEffect.severity,
          heuristic: true,
        });
      }
      for (const rule of rulesForResource)
        if (!existing.rules.includes(rule)) existing.rules.push(rule);
    }
  }

  const covered = new Set(byResource.keys());
  for (const provider of providers) {
    for (const resourceId of provider.resourceIds) {
      if (covered.has(resourceId)) continue;
      const resource = resources.find(
        (candidate) => candidate.resourceId === resourceId,
      );
      if (resource === undefined) continue;
      const ruleId = `blast-adjacent.${resourceId}`;
      if (!ruleIds.has(ruleId)) {
        rules.push({
          ruleId,
          explanation: `Provider ${provider.providerId} also exposes resource ${resourceId}; this resource is reachable through the same provider but has no verified complete path from agent ${agentId} in the current graph.`,
        });
        ruleIds.add(ruleId);
      }
      byResource.set(resourceId, {
        resourceId,
        resourceType: resource.resourceType,
        sensitive: resource.sensitive,
        providerId: provider.providerId,
        sideEffects: resource.sideEffectIds
          .map((sideEffectId) =>
            sideEffects.find(
              (candidate) => candidate.sideEffectId === sideEffectId,
            ),
          )
          .filter(
            (
              candidate,
            ): candidate is NonNullable<(typeof sideEffects)[number]> =>
              candidate !== undefined,
          )
          .map((sideEffect) => ({
            sideEffectId: sideEffect.sideEffectId,
            kind: sideEffect.kind,
            severity: sideEffect.severity,
            heuristic: true,
          })),
        pathCount: 0,
        rules: [ruleId],
      });
    }
  }

  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory-blast-radius",
    tenantId,
    agentId,
    analyzedAt: now,
    paths: result.paths,
    incompletePaths: result.incompletePaths,
    resources: [...byResource.values()],
    rules,
    heuristicNote:
      "Impact severities and reachability labels are heuristic classifications derived from recorded side effects and imported graph edges. They are advisory for review, not proof of exploitability or a measured blast radius.",
  };
}

export function computeFindings(
  state: InventoryStoreState,
  tenantId: string,
  now: string,
  freshnessDays: InventoryFreshnessDays | undefined,
): FindingRecord[] {
  const normalized = normalizeFreshnessDays(freshnessDays);
  const findings: FindingRecord[] = [];
  const agents = state.agents.filter((agent) => agent.tenantId === tenantId);
  const identities = state.identities.filter(
    (identity) => identity.tenantId === tenantId,
  );
  const tools = state.tools.filter((tool) => tool.tenantId === tenantId);
  const providers = state.providers.filter(
    (provider) => provider.tenantId === tenantId,
  );
  const resources = state.resources.filter(
    (resource) => resource.tenantId === tenantId,
  );
  const credentials = state.credentials.filter(
    (credential) => credential.tenantId === tenantId,
  );
  const policies = state.policies.filter(
    (policy) => policy.tenantId === tenantId,
  );
  const importRuns = state.importRuns.filter(
    (run) => run.tenantId === tenantId,
  );
  const knownOwners = new Set(
    identities.map((identity) => identity.principalId),
  );

  for (const agent of agents) {
    if (agent.ownerId === null || !knownOwners.has(agent.ownerId)) {
      const severity: FindingSeverity = agent.environmentIds.includes(
        PRODUCTION_ENVIRONMENT,
      )
        ? "high"
        : "medium";
      findings.push(
        makeFinding(
          tenantId,
          "orphaned_agents",
          severity,
          "agent",
          agent.agentId,
          "rule.orphaned_agents",
          `Agent ${agent.agentId} has no declared owner${agent.ownerId === null ? "" : ` (owner ${agent.ownerId} is not a known identity principal)`}.`,
          "evidence",
          now,
        ),
      );
    }
    if (!agent.gatewayManaged) {
      findings.push(
        makeFinding(
          tenantId,
          "agents_outside_gateway",
          "medium",
          "agent",
          agent.agentId,
          "rule.agents_outside_gateway",
          `Agent ${agent.agentId} is not managed through the GhostAPI gateway and can reach tools or providers directly.`,
          "evidence",
          now,
        ),
      );
    }
    if (agent.lastEvidenceAt === null) {
      findings.push(
        makeFinding(
          tenantId,
          "missing_evidence",
          "medium",
          "agent",
          agent.agentId,
          "rule.missing_evidence",
          `Agent ${agent.agentId} has no recorded safety evidence (no evidence metadata imported).`,
          "evidence",
          now,
        ),
      );
    } else {
      const ageDays =
        (Date.parse(now) - Date.parse(agent.lastEvidenceAt)) /
        (24 * 60 * 60 * 1000);
      if (ageDays > normalized.evidenceFreshDays) {
        findings.push(
          makeFinding(
            tenantId,
            "missing_evidence",
            "low",
            "agent",
            agent.agentId,
            "rule.stale_evidence",
            `Agent ${agent.agentId} has evidence older than ${normalized.evidenceFreshDays} days (last evidence ${agent.lastEvidenceAt}).`,
            "evidence",
            now,
          ),
        );
      }
    }
    if (
      agent.environmentIds.includes(PRODUCTION_ENVIRONMENT) &&
      !agent.killSwitchEnabled
    ) {
      findings.push(
        makeFinding(
          tenantId,
          "missing_kill_switch",
          "high",
          "agent",
          agent.agentId,
          "rule.missing_agent_kill_switch",
          `Agent ${agent.agentId} operates in a production environment without an enabled kill switch.`,
          "evidence",
          now,
        ),
      );
    }
  }

  for (const provider of providers) {
    if (
      provider.environmentIds.includes(PRODUCTION_ENVIRONMENT) &&
      provider.ownerId === null
    ) {
      findings.push(
        makeFinding(
          tenantId,
          "unowned_production_integrations",
          "high",
          "provider",
          provider.providerId,
          "rule.unowned_production_provider",
          `Provider ${provider.providerId} is a production integration without an owner.`,
          "evidence",
          now,
        ),
      );
    }
    if (
      provider.environmentIds.includes(PRODUCTION_ENVIRONMENT) &&
      !provider.killSwitchApplied
    ) {
      findings.push(
        makeFinding(
          tenantId,
          "missing_kill_switch",
          "high",
          "provider",
          provider.providerId,
          "rule.missing_provider_kill_switch",
          `Provider ${provider.providerId} is a production integration without a GhostAPI kill switch applied.`,
          "evidence",
          now,
        ),
      );
    }
  }

  for (const resource of resources) {
    if (
      resource.environmentIds.includes(PRODUCTION_ENVIRONMENT) &&
      resource.ownerId === null
    ) {
      findings.push(
        makeFinding(
          tenantId,
          "unowned_production_integrations",
          "high",
          "resource",
          resource.resourceId,
          "rule.unowned_production_resource",
          `Resource ${resource.resourceId} is a production resource without an owner.`,
          "evidence",
          now,
        ),
      );
    }
  }

  for (const credential of credentials) {
    if (credential.status !== "active") continue;
    const unusedDays =
      credential.lastUsedAt === null
        ? null
        : (Date.parse(now) - Date.parse(credential.lastUsedAt)) /
          (24 * 60 * 60 * 1000);
    if (unusedDays === null || unusedDays > normalized.credentialStaleDays) {
      findings.push(
        makeFinding(
          tenantId,
          "stale_unused_credentials",
          "medium",
          "credential",
          credential.credentialId,
          "rule.stale_unused_credentials",
          `Credential ${credential.credentialId} is active but unused${unusedDays === null ? " (never used)" : ` for ${Math.floor(unusedDays)} days`}.`,
          "evidence",
          now,
        ),
      );
    }
    const required = new Set<string>();
    for (const toolId of credential.toolIds) {
      const tool = tools.find((candidate) => candidate.toolId === toolId);
      if (tool !== undefined)
        for (const scope of tool.requiredScopes) required.add(scope);
    }
    const extra = credential.grantScopes.filter(
      (scope) => !required.has(scope),
    );
    if (extra.length > 0) {
      findings.push(
        makeFinding(
          tenantId,
          "excessive_permissions",
          "medium",
          "credential",
          credential.credentialId,
          "rule.excessive_permissions",
          `Credential ${credential.credentialId} grants scopes [${extra.join(", ")}] that are not required by any bound tool. Heuristic scope analysis; confirm before reducing.`,
          "heuristic",
          now,
        ),
      );
    }
  }

  const environmentsWithAgents = new Set<string>();
  for (const agent of agents)
    for (const environmentId of agent.environmentIds)
      environmentsWithAgents.add(environmentId);
  for (const environmentId of environmentsWithAgents) {
    const covered = policies.some((policy) =>
      policy.environmentIds.includes(environmentId),
    );
    if (!covered) {
      const agentCount = agents.filter((agent) =>
        agent.environmentIds.includes(environmentId),
      ).length;
      findings.push(
        makeFinding(
          tenantId,
          "policy_drift",
          "medium",
          "environment",
          environmentId,
          "rule.policy_missing",
          `No policy covers environment ${environmentId} used by ${agentCount} active agent(s).`,
          "evidence",
          now,
        ),
      );
    }
  }
  const latestExpectationsBySource = new Map<string, ImportRunRecord>();
  for (const run of importRuns) {
    if (run.expectedPolicyHashes.length > 0)
      latestExpectationsBySource.set(run.source.sourceId, run);
  }
  for (const run of latestExpectationsBySource.values()) {
    for (const expectation of run.expectedPolicyHashes) {
      const matching = policies.filter((policy) =>
        policy.environmentIds.includes(expectation.environmentId),
      );
      const matchingHash = matching.some(
        (policy) => policy.hash === expectation.policyHash,
      );
      if (!matchingHash) {
        const stored =
          matching.map((policy) => policy.hash).join(", ") || "none";
        findings.push(
          makeFinding(
            tenantId,
            "policy_drift",
            "high",
            "environment",
            expectation.environmentId,
            "rule.policy_drift",
            `Policy drift for environment ${expectation.environmentId}: expected hash ${expectation.policyHash} from source ${run.source.sourceId}, stored policy hash(es) [${stored}].`,
            "evidence",
            now,
          ),
        );
      }
    }
  }

  return findings;
}

export function computeCoverage(
  state: InventoryStoreState,
  tenantId: string,
  now: string,
  freshnessDays: InventoryFreshnessDays | undefined,
): CoverageMetrics {
  const normalized = normalizeFreshnessDays(freshnessDays);
  const agents = state.agents.filter((agent) => agent.tenantId === tenantId);
  const providers = state.providers.filter(
    (provider) => provider.tenantId === tenantId,
  );
  const credentials = state.credentials.filter(
    (credential) => credential.tenantId === tenantId,
  );
  const policies = state.policies.filter(
    (policy) => policy.tenantId === tenantId,
  );

  let policyCoveredAgents = 0;
  let evidenceFreshAgents = 0;
  let gatewayManagedAgents = 0;
  for (const agent of agents) {
    if (
      policies.some((policy) =>
        agent.environmentIds.some((environmentId) =>
          policy.environmentIds.includes(environmentId),
        ),
      )
    )
      policyCoveredAgents += 1;
    if (agent.lastEvidenceAt !== null) {
      const ageDays =
        (Date.parse(now) - Date.parse(agent.lastEvidenceAt)) /
        (24 * 60 * 60 * 1000);
      if (ageDays <= normalized.evidenceFreshDays) evidenceFreshAgents += 1;
    }
    if (agent.gatewayManaged) gatewayManagedAgents += 1;
  }
  const productionProviders = providers.filter((provider) =>
    provider.environmentIds.includes(PRODUCTION_ENVIRONMENT),
  );
  const killSwitchProviders = productionProviders.filter(
    (provider) => provider.killSwitchApplied,
  ).length;
  const directCredentials = credentials.filter(
    (credential) => credential.status === "active" && !credential.gatewayBound,
  ).length;
  const outsideGatewayAgents = agents.filter(
    (agent) => !agent.gatewayManaged,
  ).length;
  const unownedProduction =
    state.providers.filter(
      (provider) =>
        provider.tenantId === tenantId &&
        provider.environmentIds.includes(PRODUCTION_ENVIRONMENT) &&
        provider.ownerId === null,
    ).length + resourcesInProductionWithoutOwner(state, tenantId);

  return {
    activeAgents: agents.length,
    policyCoveredAgents,
    evidenceFreshAgents,
    gatewayManagedAgents,
    productionProviders: productionProviders.length,
    killSwitchProviders,
    directCredentials,
    outsideGatewayAgents,
    unownedProduction,
    policyCoverageBps: bps(policyCoveredAgents, agents.length),
    evidenceCoverageBps: bps(evidenceFreshAgents, agents.length),
    gatewayCoverageBps: bps(gatewayManagedAgents, agents.length),
    killSwitchCoverageBps: bps(killSwitchProviders, productionProviders.length),
  };
}

function resourcesInProductionWithoutOwner(
  state: InventoryStoreState,
  tenantId: string,
): number {
  return state.resources.filter(
    (resource) =>
      resource.tenantId === tenantId &&
      resource.environmentIds.includes(PRODUCTION_ENVIRONMENT) &&
      resource.ownerId === null,
  ).length;
}

export function computeRemovalAnalysis(
  state: InventoryStoreState,
  tenantId: string,
  now: string,
  freshnessDays: InventoryFreshnessDays | undefined,
): RemovalAnalysis {
  const coverage = computeCoverage(state, tenantId, now, freshnessDays);
  const normalized = normalizeFreshnessDays(freshnessDays);
  const lost: string[] = [];
  if (coverage.policyCoveredAgents > 0) {
    lost.push(
      `${coverage.policyCoveredAgents} of ${coverage.activeAgents} active agents (${coverage.policyCoverageBps} bps) currently rely on GhostAPI-stored policy coverage for their environments.`,
    );
  }
  if (coverage.gatewayManagedAgents > 0) {
    lost.push(
      `${coverage.gatewayManagedAgents} of ${coverage.activeAgents} active agents are gateway-managed; without GhostAPI they would revert to direct tool/provider access.`,
    );
  }
  if (coverage.directCredentials > 0) {
    lost.push(
      `${coverage.directCredentials} active credential(s) are not gateway-bound and already represent direct access.`,
    );
  }
  if (coverage.productionProviders > 0) {
    lost.push(
      `${coverage.killSwitchProviders} of ${coverage.productionProviders} production providers have a GhostAPI kill switch; without GhostAPI the remaining ${coverage.productionProviders - coverage.killSwitchProviders} are not stop-controlled in GhostAPI.`,
    );
  }
  if (coverage.evidenceFreshAgents > 0) {
    lost.push(
      `${coverage.evidenceFreshAgents} agents have evidence fresh within the last ${normalized.evidenceFreshDays} days; without GhostAPI no evidence freshness is tracked.`,
    );
  }
  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory-removal-analysis",
    tenantId,
    generatedAt: now,
    basis: "local_inventory_data",
    coverage,
    lostWithoutGhostApi: lost,
  };
}

export function computeRoiReport(
  state: InventoryStoreState,
  tenantId: string,
  now: string,
  freshnessDays: InventoryFreshnessDays | undefined,
): RoiReport {
  const coverage = computeCoverage(state, tenantId, now, freshnessDays);
  const importRuns = state.importRuns.filter(
    (run) => run.tenantId === tenantId && run.counters !== undefined,
  );
  const latestBySource = new Map<string, ImportRunRecord>();
  for (const run of importRuns.sort(
    (a, b) => Date.parse(a.importedAt) - Date.parse(b.importedAt),
  ))
    latestBySource.set(run.source.sourceId, run);

  const preventedSources: RoiCounterRow[] = [];
  const reviewSources: RoiCounterRow[] = [];
  const mttcSources: RoiCounterRow[] = [];
  let preventedEgressAttempts = 0;
  let reviewTimeMinutes = 0;
  let reviewTimeMeasured = false;
  let meanTimeToContainMinutes = 0;
  let mttcMeasured = false;
  for (const run of latestBySource.values()) {
    if (run.counters!.preventedEgressAttempts !== undefined) {
      preventedEgressAttempts += run.counters!.preventedEgressAttempts;
      preventedSources.push({
        sourceId: run.source.sourceId,
        sourceType: run.source.sourceType,
        sourceName: run.source.sourceName,
        value: run.counters!.preventedEgressAttempts,
      });
    }
    if (run.counters!.reviewTimeMinutes !== undefined) {
      reviewTimeMinutes += run.counters!.reviewTimeMinutes;
      reviewTimeMeasured = true;
      reviewSources.push({
        sourceId: run.source.sourceId,
        sourceType: run.source.sourceType,
        sourceName: run.source.sourceName,
        value: run.counters!.reviewTimeMinutes,
      });
    }
    if (run.counters!.meanTimeToContainMinutes !== undefined) {
      meanTimeToContainMinutes += run.counters!.meanTimeToContainMinutes;
      mttcMeasured = true;
      mttcSources.push({
        sourceId: run.source.sourceId,
        sourceType: run.source.sourceType,
        sourceName: run.source.sourceName,
        value: run.counters!.meanTimeToContainMinutes,
      });
    }
  }

  const credentials = state.credentials.filter(
    (credential) => credential.tenantId === tenantId,
  );
  const remediations = state.remediations.filter(
    (remediation) =>
      remediation.tenantId === tenantId && remediation.status === "applied",
  );
  const revokedCredentialIds = new Set(
    remediations
      .filter(
        (remediation) =>
          remediation.kind === "revoke" &&
          remediation.targetKind === "credential",
      )
      .map((remediation) => remediation.targetId),
  );
  const unusedGrantsRemoved = credentials.filter(
    (credential) =>
      credential.status === "revoked" &&
      revokedCredentialIds.has(credential.credentialId),
  ).length;
  const excessiveScopeReductions = remediations.filter(
    (remediation) => remediation.kind === "reduce_scope",
  ).length;
  const ownedGrants = remediations.filter(
    (remediation) => remediation.kind === "assign_owner",
  ).length;
  const onboardedAgents = remediations.filter(
    (remediation) => remediation.kind === "onboard_through_gateway",
  ).length;
  const evalsCreated = remediations.filter(
    (remediation) => remediation.kind === "create_eval",
  ).length;

  const notMeasured: string[] = [];
  if (!reviewTimeMeasured) notMeasured.push("review_time_minutes");
  if (!mttcMeasured) notMeasured.push("mean_time_to_contain_minutes");
  if (preventedEgressAttempts === 0)
    notMeasured.push("prevented_egress_attempts");

  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory-roi",
    tenantId,
    generatedAt: now,
    basis: "local_inventory_data_only",
    activeAgentCount: coverage.activeAgents,
    productionProviderCount: coverage.productionProviders,
    incidents: {
      preventedEgressAttempts,
      preventedEgressSources: preventedSources,
      reviewTimeMinutes: reviewTimeMeasured ? reviewTimeMinutes : null,
      reviewTimeSources: reviewSources,
      meanTimeToContainMinutes: mttcMeasured ? meanTimeToContainMinutes : null,
      meanTimeToContainSources: mttcSources,
    },
    remediationOutcomes: {
      unusedGrantsRemoved,
      excessiveScopeReductions,
      ownedGrants,
      onboardedAgents,
      evalsCreated,
    },
    coverage: {
      policyCoverageBps: coverage.policyCoverageBps,
      evidenceCoverageBps: coverage.evidenceCoverageBps,
      gatewayCoverageBps: coverage.gatewayCoverageBps,
      killSwitchCoverageBps: coverage.killSwitchCoverageBps,
    },
    notMeasured,
  };
}

function makeFinding(
  tenantId: string,
  kind: FindingRecord["kind"],
  severity: FindingSeverity,
  targetKind: FindingRecord["targetKind"],
  targetId: string,
  ruleId: string,
  reason: string,
  basis: FindingRecord["basis"],
  now: string,
): FindingRecord {
  const findingId = `finding-${sha256Digest(`${tenantId}:${kind}:${targetKind}:${targetId}`).slice(0, 32)}`;
  return {
    schemaVersion: 1,
    tenantId,
    findingId,
    kind,
    severity,
    targetKind,
    targetId,
    ruleId,
    reason,
    basis,
    discoveredAt: now,
    status: "open",
  };
}

export function findingKey(
  record: Pick<FindingRecord, "kind" | "targetKind" | "targetId">,
): FindingKey {
  return `${record.kind}:${record.targetKind}:${record.targetId}`;
}

function bps(count: number, total: number): number {
  return total === 0 ? 0 : Math.floor((count * 10_000) / total);
}

export type {
  AttackPath,
  AttackPathResult,
  BlastRadiusReport,
  BlastRadiusResource,
  BlastRadiusRule,
  CoverageMetrics,
  GraphEdgeView,
  RemovalAnalysis,
  RoiCounterRow,
  RoiReport,
};
