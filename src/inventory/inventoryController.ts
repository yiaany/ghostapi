import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import {
  atomicWriteJson,
  ensurePrivateDirectory,
  withFileLock,
} from "../storage/fileStore.js";
import { sanitizeSecretString } from "../security/secrets.js";
import { normalizeFreshnessDays } from "./analysis.js";
import {
  type AttackPathResult,
  type BlastRadiusReport,
  type GraphEdgeView,
  type ImportRunRecord,
  type ImportSummary,
  type ImportedAgent,
  type ImportedCredential,
  type ImportedIdentity,
  type ImportedPolicy,
  type ImportedProvider,
  type ImportedResource,
  type ImportedSideEffect,
  type ImportedTool,
  type InventoryExport,
  type InventoryFreshnessDays,
  type InventoryImportPayload,
  type InventoryOperator,
  type InventoryOperatorAuthorizer,
  type InventoryOperatorPermission,
  type InventorySnapshot,
  type InventoryStoreState,
  type RecordFreshness,
  type RemovalAnalysis,
  type RoiReport,
  InventoryError,
  INVENTORY_LIMITS,
  buildRecordFreshness,
  buildRecordProvenance,
  canonicalPayloadDigest,
  clone,
  edgeIdFor,
  emptyInventoryState,
  freshnessStatusFor,
  validateImportPayload,
  validateOperator,
  validateState,
} from "./types.js";
import {
  computeBlastRadius,
  computeFindings,
  computeRemovalAnalysis,
  computeRoiReport,
  findAttackPaths,
  findingKey,
  graphEdges,
} from "./analysis.js";

type ImportOutcome = {
  recordCounts: ImportRunRecord["recordCounts"];
  edgesCreated: number;
  edgesRefreshed: number;
};

export type InventoryControllerOptions = {
  path?: string;
  now?: () => Date;
  operatorAuthorizer?: InventoryOperatorAuthorizer;
  freshnessDays?: InventoryFreshnessDays;
  evalScenarioExists?: (scenarioId: string) => boolean;
};

export class LocalInventoryController {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly operatorAuthorizer: InventoryOperatorAuthorizer;
  private readonly freshnessDays: InventoryFreshnessDays | undefined;
  private readonly evalScenarioExists:
    ((scenarioId: string) => boolean) | undefined;

  constructor(options: InventoryControllerOptions = {}) {
    this.path = options.path ?? getDataPaths().inventoryStore;
    this.now = options.now ?? (() => new Date());
    this.operatorAuthorizer =
      options.operatorAuthorizer ?? createDisabledInventoryOperatorAuthorizer();
    this.freshnessDays = options.freshnessDays;
    this.evalScenarioExists = options.evalScenarioExists;
  }

  async import(
    identityValue: unknown,
    payloadValue: unknown,
  ): Promise<ImportSummary> {
    const operator = await this.authorize(identityValue, "inventory.import");
    const payload = validateImportPayload(payloadValue);
    const now = this.timestamp();
    const digest = canonicalPayloadDigest(payload);
    const runId = `import-${randomUUID().replace(/-/g, "").slice(0, 32)}`;
    return this.mutate((state) => {
      this.upsertSource(state, operator.tenantId, payload, now);
      const before = new Map<string, InventoryStoreState["edges"][number]>();
      for (const edge of state.edges) before.set(edge.edgeId, edge);
      const upserted: { kind: InventoryRecordKind; id: string }[] = [];
      const counts: ImportRunRecord["recordCounts"] = {
        agents: 0,
        tools: 0,
        identities: 0,
        providers: 0,
        resources: 0,
        sideEffects: 0,
        credentials: 0,
        policies: 0,
      };
      const imported = new ImportedRecords(payload);

      for (const input of payload.agents ?? []) {
        upsertAgent(
          state,
          operator.tenantId,
          input,
          payload,
          operator.principalId,
          now,
        );
        upserted.push({ kind: "agent", id: input.agentId });
        counts.agents += 1;
      }
      for (const input of payload.tools ?? []) {
        upsertTool(
          state,
          operator.tenantId,
          input,
          payload,
          operator.principalId,
          now,
        );
        upserted.push({ kind: "tool", id: input.toolId });
        counts.tools += 1;
      }
      for (const input of payload.identities ?? []) {
        upsertIdentity(
          state,
          operator.tenantId,
          input,
          payload,
          operator.principalId,
          now,
        );
        upserted.push({ kind: "identity", id: input.identityId });
        counts.identities += 1;
      }
      for (const input of payload.providers ?? []) {
        upsertProvider(
          state,
          operator.tenantId,
          input,
          payload,
          operator.principalId,
          now,
        );
        upserted.push({ kind: "provider", id: input.providerId });
        counts.providers += 1;
      }
      for (const input of payload.resources ?? []) {
        upsertResource(
          state,
          operator.tenantId,
          input,
          payload,
          operator.principalId,
          now,
        );
        upserted.push({ kind: "resource", id: input.resourceId });
        counts.resources += 1;
      }
      for (const input of payload.sideEffects ?? []) {
        upsertSideEffect(
          state,
          operator.tenantId,
          input,
          payload,
          operator.principalId,
          now,
        );
        upserted.push({ kind: "side_effect", id: input.sideEffectId });
        counts.sideEffects += 1;
      }
      for (const input of payload.credentials ?? []) {
        upsertCredential(
          state,
          operator.tenantId,
          input,
          payload,
          operator.principalId,
          now,
        );
        upserted.push({ kind: "credential", id: input.credentialId });
        counts.credentials += 1;
      }
      for (const input of payload.policies ?? []) {
        upsertPolicy(
          state,
          operator.tenantId,
          input,
          payload,
          operator.principalId,
          now,
        );
        upserted.push({ kind: "policy", id: input.policyId });
        counts.policies += 1;
      }
      validateCrossReferences(state, operator.tenantId, imported);

      const outcome = upsertEdges(
        state,
        operator.tenantId,
        upserted,
        payload,
        operator.principalId,
        now,
        before,
      );
      this.pruneStaleEdges(state, operator.tenantId, now);
      this.assertStoreBounds(state);
      state.importRuns.push({
        schemaVersion: 1,
        kind: "ghostapi.inventory-import-run",
        tenantId: operator.tenantId,
        runId,
        importedAt: now,
        importedBy: operator.principalId,
        source: {
          sourceId: payload.source.sourceId,
          sourceType: payload.source.sourceType,
          sourceName: payload.source.sourceName,
          ...(payload.source.sourceVersion === undefined
            ? {}
            : { sourceVersion: payload.source.sourceVersion }),
        },
        digest,
        expectedPolicyHashes: payload.expectedPolicyHashes ?? [],
        ...(payload.counters === undefined
          ? {}
          : { counters: payload.counters }),
        recordCounts: counts,
        edgesCreated: outcome.edgesCreated,
        edgesRefreshed: outcome.edgesRefreshed,
        status: "completed",
      });
      this.rotateImportRuns(state, operator.tenantId);
      return {
        runId,
        importedAt: now,
        digest,
        recordCounts: counts,
        edgesCreated: outcome.edgesCreated,
        edgesRefreshed: outcome.edgesRefreshed,
      };
    });
  }

  async inspect(identityValue: unknown): Promise<InventorySnapshot> {
    const operator = await this.authorize(identityValue, "inventory.inspect");
    const state = await this.read();
    return snapshotFor(
      state,
      operator.tenantId,
      this.timestamp(),
      this.freshnessDays,
    );
  }

  async analyze(
    identityValue: unknown,
  ): Promise<{ findings: number; resolved: number }> {
    const operator = await this.authorize(identityValue, "inventory.analyze");
    const now = this.timestamp();
    return this.mutate((state) => {
      const previous = new Map<
        string,
        InventoryStoreState["findings"][number]
      >();
      for (const finding of state.findings) {
        if (finding.tenantId === operator.tenantId)
          previous.set(findingKey(finding), finding);
      }
      const computed = computeFindings(
        state,
        operator.tenantId,
        now,
        this.freshnessDays,
      );
      let resolved = 0;
      const appliedRemediations = state.remediations.filter(
        (remediation) =>
          remediation.tenantId === operator.tenantId &&
          remediation.status === "applied",
      );
      const nextFindings = computed.map((finding) => {
        const prior = previous.get(findingKey(finding));
        const matchingRemediation = appliedRemediations.find(
          (remediation) =>
            remediation.findingId === finding.findingId &&
            remediation.targetKind === finding.targetKind &&
            remediation.targetId === finding.targetId,
        );
        if (matchingRemediation !== undefined) {
          if (
            this.isRemediationEffective(
              state,
              operator.tenantId,
              matchingRemediation,
            )
          ) {
            resolved += 1;
            return {
              ...finding,
              status: "resolved" as const,
              resolvedAt: matchingRemediation.appliedAt,
              remediationId: matchingRemediation.remediationId,
            };
          }
          return finding;
        }
        if (prior !== undefined && prior.status === "resolved") {
          return {
            ...finding,
            status: "resolved" as const,
            resolvedAt: prior.resolvedAt,
            ...(prior.remediationId === undefined
              ? {}
              : { remediationId: prior.remediationId }),
          };
        }
        return finding;
      });
      state.findings = [
        ...state.findings.filter(
          (finding) => finding.tenantId !== operator.tenantId,
        ),
        ...nextFindings,
      ];
      this.assertStoreBounds(state);
      return { findings: nextFindings.length, resolved };
    });
  }

  async graph(identityValue: unknown): Promise<GraphEdgeView[]> {
    const operator = await this.authorize(identityValue, "inventory.inspect");
    const state = await this.read();
    return graphEdges(
      state,
      operator.tenantId,
      this.timestamp(),
      this.freshnessDays,
    );
  }

  async attackPaths(
    identityValue: unknown,
    agentId: string,
  ): Promise<AttackPathResult> {
    const operator = await this.authorize(identityValue, "inventory.inspect");
    const state = await this.read();
    return findAttackPaths(
      state,
      operator.tenantId,
      safeIdentifier(agentId, "Agent id"),
      this.timestamp(),
      this.freshnessDays,
    );
  }

  async blastRadius(
    identityValue: unknown,
    agentId: string,
  ): Promise<BlastRadiusReport> {
    const operator = await this.authorize(identityValue, "inventory.inspect");
    const state = await this.read();
    return computeBlastRadius(
      state,
      operator.tenantId,
      safeIdentifier(agentId, "Agent id"),
      this.timestamp(),
      this.freshnessDays,
    );
  }

  async removalAnalysis(identityValue: unknown): Promise<RemovalAnalysis> {
    const operator = await this.authorize(identityValue, "inventory.analyze");
    const state = await this.read();
    return computeRemovalAnalysis(
      state,
      operator.tenantId,
      this.timestamp(),
      this.freshnessDays,
    );
  }

  async roiReport(identityValue: unknown): Promise<RoiReport> {
    const operator = await this.authorize(identityValue, "inventory.analyze");
    const state = await this.read();
    return computeRoiReport(
      state,
      operator.tenantId,
      this.timestamp(),
      this.freshnessDays,
    );
  }

  async proposeRemediation(
    identityValue: unknown,
    input: unknown,
  ): Promise<InventoryStoreState["remediations"][number]> {
    const operator = await this.authorize(identityValue, "inventory.remediate");
    const proposal = validateRemediationProposal(input);
    const now = this.timestamp();
    return this.mutate((state) => {
      const finding = state.findings.find(
        (candidate) =>
          candidate.tenantId === operator.tenantId &&
          candidate.findingId === proposal.findingId,
      );
      if (finding === undefined)
        throw new InventoryError(
          "Remediation finding was not found for the tenant.",
        );
      if (finding.status === "resolved")
        throw new InventoryError(
          "Cannot propose remediation for a resolved finding.",
        );
      if (
        proposal.targetKind !== finding.targetKind ||
        proposal.targetId !== finding.targetId
      )
        throw new InventoryError(
          "Remediation target does not match the finding target.",
        );
      this.assertRemediationTargetExists(
        state,
        operator.tenantId,
        proposal.targetKind,
        proposal.targetId,
      );
      if (proposal.kind === "reduce_scope") {
        if (proposal.targetKind !== "credential")
          throw new InventoryError(
            "reduce_scope remediation only supports credential targets.",
          );
        const credential = state.credentials.find(
          (candidate) =>
            candidate.tenantId === operator.tenantId &&
            candidate.credentialId === proposal.targetId,
        );
        if (credential === undefined)
          throw new InventoryError(
            "Remediation target credential does not exist.",
          );
        if (credential.status !== "active")
          throw new InventoryError(
            "Cannot reduce scopes on a revoked credential.",
          );
        const reduced = proposal.reducedScopes!;
        for (const scope of reduced)
          if (!credential.grantScopes.includes(scope))
            throw new InventoryError(
              "Reduced scopes must be a subset of the current grant scopes; permissions are never expanded.",
            );
        if (reduced.length >= credential.grantScopes.length)
          throw new InventoryError(
            "reduce_scope must remove at least one scope; permissions are never expanded.",
          );
      }
      if (
        proposal.kind === "create_eval" &&
        this.evalScenarioExists !== undefined &&
        !this.evalScenarioExists(proposal.evalScenarioId!)
      )
        throw new InventoryError(
          "Eval scenario was not found for create_eval remediation.",
        );
      if (state.remediations.length >= INVENTORY_LIMITS.maxRemediations)
        throw new InventoryError("Remediation limit was reached.");
      const remediationId = `remediation-${randomUUID().replace(/-/g, "").slice(0, 32)}`;
      const record = {
        schemaVersion: 1,
        tenantId: operator.tenantId,
        remediationId,
        findingId: finding.findingId,
        kind: proposal.kind,
        targetKind: proposal.targetKind,
        targetId: proposal.targetId,
        rationale: proposal.rationale,
        proposedBy: operator.principalId,
        createdAt: now,
        status: "proposed" as const,
        ...(proposal.ownerId === undefined &&
        proposal.reducedScopes === undefined &&
        proposal.evalScenarioId === undefined
          ? {}
          : { result: remediationResult(proposal, operator.principalId) }),
      } as const;
      state.remediations.push(record);
      this.assertStoreBounds(state);
      return clone(record);
    });
  }

  async applyRemediation(
    identityValue: unknown,
    remediationId: string,
  ): Promise<InventoryStoreState["remediations"][number]> {
    const operator = await this.authorize(identityValue, "inventory.remediate");
    const now = this.timestamp();
    const safeRemediationId = safeIdentifier(remediationId, "Remediation id");
    return this.mutate((state) => {
      const index = state.remediations.findIndex(
        (candidate) =>
          candidate.tenantId === operator.tenantId &&
          candidate.remediationId === safeRemediationId,
      );
      if (index === -1)
        throw new InventoryError("Remediation was not found for the tenant.");
      const remediation = state.remediations[index];
      if (remediation.status === "applied")
        throw new InventoryError("Remediation was already applied.");
      if (remediation.status === "rejected" || remediation.status === "expired")
        throw new InventoryError(
          `Remediation is ${remediation.status} and cannot be applied.`,
        );
      applyRemediationEffect(state, operator.tenantId, remediation, now);
      const applied = {
        ...remediation,
        status: "applied" as const,
        appliedAt: now,
      };
      state.remediations[index] = applied;
      const finding = state.findings.find(
        (candidate) =>
          candidate.tenantId === operator.tenantId &&
          candidate.findingId === remediation.findingId,
      );
      if (finding !== undefined) {
        finding.status = "resolved";
        finding.resolvedAt = now;
        finding.remediationId = remediation.remediationId;
      }
      this.assertStoreBounds(state);
      return clone(applied);
    });
  }

  async rejectRemediation(
    identityValue: unknown,
    remediationId: string,
  ): Promise<InventoryStoreState["remediations"][number]> {
    const operator = await this.authorize(identityValue, "inventory.remediate");
    const safeRemediationId = safeIdentifier(remediationId, "Remediation id");
    return this.mutate((state) => {
      const index = state.remediations.findIndex(
        (candidate) =>
          candidate.tenantId === operator.tenantId &&
          candidate.remediationId === safeRemediationId,
      );
      if (index === -1)
        throw new InventoryError("Remediation was not found for the tenant.");
      const remediation = state.remediations[index];
      if (remediation.status === "applied")
        throw new InventoryError(
          "Remediation is already applied and cannot be rejected.",
        );
      const rejected = { ...remediation, status: "rejected" as const };
      state.remediations[index] = rejected;
      return clone(rejected);
    });
  }

  async listRemediations(
    identityValue: unknown,
  ): Promise<InventoryStoreState["remediations"][number][]> {
    const operator = await this.authorize(identityValue, "inventory.inspect");
    const state = await this.read();
    return clone(
      state.remediations.filter(
        (remediation) => remediation.tenantId === operator.tenantId,
      ),
    );
  }

  async export(identityValue: unknown): Promise<InventoryExport> {
    const operator = await this.authorize(identityValue, "inventory.export");
    const state = await this.read();
    const now = this.timestamp();
    const tenantId = operator.tenantId;
    const snapshot = snapshotFor(state, tenantId, now, this.freshnessDays);
    const scenarioRefs = state.remediations
      .filter(
        (remediation) =>
          remediation.tenantId === tenantId &&
          remediation.status === "applied" &&
          remediation.kind === "create_eval" &&
          remediation.result?.evalScenarioId !== undefined,
      )
      .map((remediation) => ({
        evalScenarioId: remediation.result!.evalScenarioId!,
        forFindingId: remediation.findingId,
        createdBy: remediation.proposedBy,
      }));
    const normalized = normalizeFreshnessDays(this.freshnessDays);
    const evidenceMetadata = snapshot.agents.map((agent) => ({
      agentId: agent.agentId,
      lastEvidenceAt: agent.lastEvidenceAt,
      status:
        agent.lastEvidenceAt === null
          ? ("missing" as const)
          : freshnessStatusFor(
              agent.lastEvidenceAt,
              now,
              normalized.evidenceFreshDays,
            ),
    }));
    return {
      schemaVersion: 1,
      kind: "ghostapi.inventory-export",
      tenantId,
      exportedAt: now,
      inventory: snapshot,
      policyRecords: clone(snapshot.policies),
      scenarioRefs,
      evidenceMetadata,
      removalAnalysis: computeRemovalAnalysis(
        state,
        tenantId,
        now,
        this.freshnessDays,
      ),
      roi: computeRoiReport(state, tenantId, now, this.freshnessDays),
    };
  }

  private async authorize(
    identity: unknown,
    permission: InventoryOperatorPermission,
  ): Promise<InventoryOperator> {
    const operator = validateOperator(
      await this.operatorAuthorizer.authenticate(identity),
    );
    if (!operator.permissions.includes(permission))
      throw new InventoryError(
        `Inventory operator lacks required permission: ${permission}.`,
      );
    return operator;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      throw new InventoryError("Inventory clock is invalid.");
    return value.toISOString();
  }

  private upsertSource(
    state: InventoryStoreState,
    tenantId: string,
    payload: InventoryImportPayload,
    now: string,
  ): void {
    const existing = state.sources.find(
      (source) =>
        source.tenantId === tenantId &&
        source.sourceId === payload.source.sourceId,
    );
    if (existing === undefined) {
      if (state.sources.length >= INVENTORY_LIMITS.maxSources)
        throw new InventoryError("Import source limit was reached.");
      state.sources.push({
        tenantId,
        sourceId: payload.source.sourceId,
        sourceType: payload.source.sourceType,
        sourceName: payload.source.sourceName,
        ...(payload.source.sourceVersion === undefined
          ? {}
          : { sourceVersion: payload.source.sourceVersion }),
        firstSeenAt: now,
        lastSeenAt: now,
        lastDigest: canonicalPayloadDigest(payload),
      });
    } else {
      existing.lastSeenAt = now;
      existing.lastDigest = canonicalPayloadDigest(payload);
      if (payload.source.sourceVersion !== undefined)
        existing.sourceVersion = payload.source.sourceVersion;
    }
  }

  private assertRemediationTargetExists(
    state: InventoryStoreState,
    tenantId: string,
    targetKind: InventoryStoreState["findings"][number]["targetKind"],
    targetId: string,
  ): void {
    const exists =
      targetKind === "agent"
        ? state.agents.some(
            (record) =>
              record.tenantId === tenantId && record.agentId === targetId,
          )
        : targetKind === "identity"
          ? state.identities.some(
              (record) =>
                record.tenantId === tenantId && record.identityId === targetId,
            )
          : targetKind === "tool"
            ? state.tools.some(
                (record) =>
                  record.tenantId === tenantId && record.toolId === targetId,
              )
            : targetKind === "provider"
              ? state.providers.some(
                  (record) =>
                    record.tenantId === tenantId &&
                    record.providerId === targetId,
                )
              : targetKind === "resource"
                ? state.resources.some(
                    (record) =>
                      record.tenantId === tenantId &&
                      record.resourceId === targetId,
                  )
                : targetKind === "side_effect"
                  ? state.sideEffects.some(
                      (record) =>
                        record.tenantId === tenantId &&
                        record.sideEffectId === targetId,
                    )
                  : targetKind === "credential"
                    ? state.credentials.some(
                        (record) =>
                          record.tenantId === tenantId &&
                          record.credentialId === targetId,
                      )
                    : targetKind === "environment"
                      ? state.agents.some(
                          (record) =>
                            record.tenantId === tenantId &&
                            record.environmentIds.includes(targetId),
                        ) ||
                        state.identities.some(
                          (record) =>
                            record.tenantId === tenantId &&
                            record.environmentIds.includes(targetId),
                        ) ||
                        state.providers.some(
                          (record) =>
                            record.tenantId === tenantId &&
                            record.environmentIds.includes(targetId),
                        ) ||
                        state.resources.some(
                          (record) =>
                            record.tenantId === tenantId &&
                            record.environmentIds.includes(targetId),
                        ) ||
                        state.credentials.some(
                          (record) =>
                            record.tenantId === tenantId &&
                            record.environmentIds.includes(targetId),
                        ) ||
                        state.policies.some(
                          (record) =>
                            record.tenantId === tenantId &&
                            record.environmentIds.includes(targetId),
                        )
                      : targetKind === "policy"
                        ? state.policies.some(
                            (record) =>
                              record.tenantId === tenantId &&
                              record.policyId === targetId,
                          )
                        : false;
    if (!exists)
      throw new InventoryError(
        `Remediation target ${targetKind} ${targetId} does not exist for the tenant.`,
      );
  }

  private assertStoreBounds(state: InventoryStoreState): void {
    if (state.edges.length > INVENTORY_LIMITS.maxEdges)
      throw new InventoryError("Inventory graph edge limit was reached.");
    if (state.findings.length > INVENTORY_LIMITS.maxFindings)
      throw new InventoryError("Inventory finding limit was reached.");
  }

  private pruneStaleEdges(
    state: InventoryStoreState,
    tenantId: string,
    now: string,
  ): void {
    const normalized = normalizeFreshnessDays(this.freshnessDays);
    const staleBeforeMs =
      Date.parse(now) - normalized.edgeStaleDays * 24 * 60 * 60 * 1000;
    state.edges = state.edges.filter(
      (edge) =>
        edge.tenantId !== tenantId ||
        Date.parse(edge.lastSeenAt) >= staleBeforeMs,
    );
  }

  private rotateImportRuns(state: InventoryStoreState, tenantId: string): void {
    const tenantRuns = state.importRuns.filter(
      (run) => run.tenantId === tenantId,
    );
    if (tenantRuns.length <= INVENTORY_LIMITS.maxImports) return;
    const excess = tenantRuns.length - INVENTORY_LIMITS.maxImports;
    const oldestRunIds = new Set(
      [...tenantRuns]
        .sort((a, b) => Date.parse(a.importedAt) - Date.parse(b.importedAt))
        .slice(0, excess)
        .map((run) => run.runId),
    );
    state.importRuns = state.importRuns.filter(
      (run) => !oldestRunIds.has(run.runId),
    );
  }

  private isRemediationEffective(
    state: InventoryStoreState,
    tenantId: string,
    remediation: InventoryStoreState["remediations"][number],
  ): boolean {
    if (remediation.kind === "reduce_scope") {
      if (remediation.targetKind !== "credential") return false;
      const credential = state.credentials.find(
        (candidate) =>
          candidate.tenantId === tenantId &&
          candidate.credentialId === remediation.targetId,
      );
      const reduced = remediation.result?.reducedScopes;
      if (credential === undefined || reduced === undefined) return false;
      return credential.grantScopes.every((scope) => reduced.includes(scope));
    }
    if (remediation.kind === "revoke") {
      if (remediation.targetKind !== "credential") return false;
      const credential = state.credentials.find(
        (candidate) =>
          candidate.tenantId === tenantId &&
          candidate.credentialId === remediation.targetId,
      );
      return credential !== undefined && credential.status === "revoked";
    }
    if (remediation.kind === "assign_owner") {
      const ownerId = remediation.result?.ownerId;
      if (ownerId === undefined) return false;
      if (remediation.targetKind === "agent") {
        const record = state.agents.find(
          (candidate) =>
            candidate.tenantId === tenantId &&
            candidate.agentId === remediation.targetId,
        );
        return record !== undefined && record.ownerId === ownerId;
      }
      if (remediation.targetKind === "provider") {
        const record = state.providers.find(
          (candidate) =>
            candidate.tenantId === tenantId &&
            candidate.providerId === remediation.targetId,
        );
        return record !== undefined && record.ownerId === ownerId;
      }
      if (remediation.targetKind === "resource") {
        const record = state.resources.find(
          (candidate) =>
            candidate.tenantId === tenantId &&
            candidate.resourceId === remediation.targetId,
        );
        return record !== undefined && record.ownerId === ownerId;
      }
      if (remediation.targetKind === "credential") {
        const record = state.credentials.find(
          (candidate) =>
            candidate.tenantId === tenantId &&
            candidate.credentialId === remediation.targetId,
        );
        return record !== undefined && record.ownerId === ownerId;
      }
      return false;
    }
    if (remediation.kind === "onboard_through_gateway") {
      if (remediation.targetKind !== "agent") return false;
      const record = state.agents.find(
        (candidate) =>
          candidate.tenantId === tenantId &&
          candidate.agentId === remediation.targetId,
      );
      return record !== undefined && record.gatewayManaged === true;
    }
    if (remediation.kind === "create_eval") {
      const scenarioId = remediation.result?.evalScenarioId;
      if (scenarioId === undefined) return false;
      return this.evalScenarioExists === undefined
        ? true
        : this.evalScenarioExists(scenarioId);
    }
    return false;
  }

  private async read(): Promise<InventoryStoreState> {
    await ensurePrivateDirectory(dirname(this.path));
    const info = await lstat(this.path).catch((error: unknown) =>
      isErrorCode(error, "ENOENT") ? null : Promise.reject(error),
    );
    if (info === null) return emptyInventoryState();
    if (!info.isFile() || info.isSymbolicLink())
      throw new InventoryError(
        "Inventory store must be a regular non-symlink file.",
      );
    const source = await readFile(this.path, "utf8");
    if (Buffer.byteLength(source, "utf8") > INVENTORY_LIMITS.maxStoreBytes)
      throw new InventoryError("Inventory store exceeds its size limit.");
    try {
      return validateState(JSON.parse(source));
    } catch (error) {
      if (error instanceof InventoryError) throw error;
      throw new InventoryError("Inventory store is not valid JSON.");
    }
  }

  private async mutate<T>(
    operation: (state: InventoryStoreState) => T,
  ): Promise<T> {
    return withFileLock(this.path, async () => {
      const state = await this.read();
      const result = operation(state);
      await atomicWriteJson(this.path, validateState(state));
      return result;
    });
  }
}

export function createLocalInventoryController(
  options: InventoryControllerOptions = {},
): LocalInventoryController {
  return new LocalInventoryController(options);
}

export function createDisabledInventoryOperatorAuthorizer(): InventoryOperatorAuthorizer {
  return {
    async authenticate(): Promise<never> {
      throw new InventoryError(
        "Inventory operator authorization is not configured.",
      );
    },
  };
}

export function createTestInventoryOperatorAuthorizer(): {
  authorizer: InventoryOperatorAuthorizer;
  issue(input: InventoryOperator): InventoryOperator;
} {
  const issued = new WeakSet<object>();
  return {
    authorizer: {
      async authenticate(identity: unknown): Promise<InventoryOperator> {
        if (
          identity === null ||
          typeof identity !== "object" ||
          !issued.has(identity)
        )
          throw new InventoryError(
            "Inventory operator identity is not authenticated.",
          );
        return validateOperator(identity);
      },
    },
    issue(input): InventoryOperator {
      const operator = Object.freeze(validateOperator(input));
      issued.add(operator);
      return operator;
    },
  };
}

export function formatImportSummary(summary: ImportSummary): string {
  return `Inventory import ${summary.runId} at ${summary.importedAt} (digest ${summary.digest.slice(0, 16)}...) added ${summary.recordCounts.agents} agents, ${summary.recordCounts.tools} tools, ${summary.recordCounts.identities} identities, ${summary.recordCounts.providers} providers, ${summary.recordCounts.resources} resources, ${summary.recordCounts.sideEffects} side effects, ${summary.recordCounts.credentials} credentials, ${summary.recordCounts.policies} policies; edges created ${summary.edgesCreated}, refreshed ${summary.edgesRefreshed}.`;
}

export function formatAttackPathReport(report: AttackPathResult): string {
  const lines = [
    `Attack paths for agent ${report.agentId}: ${report.paths.length} path(s), ${report.incompletePaths} incomplete`,
  ];
  for (const path of report.paths) {
    const chain = path.steps
      .map((step) => `${step.kind}:${step.id}`)
      .join(" -> ");
    const edgeNotes =
      path.edges.length === 0
        ? " (no persisted edges)"
        : ` [edges ${path.edges.map((edge) => `${edge.sourceId}->${edge.targetId} (${edge.relation})`).join(", ")}]`;
    lines.push(
      `  ${path.complete ? "complete" : "INCOMPLETE"} ${chain}${edgeNotes}`,
    );
  }
  return lines.join("\n");
}

export function formatBlastRadiusReport(report: BlastRadiusReport): string {
  const lines = [
    `Blast radius for agent ${report.agentId}: ${report.resources.length} reachable resource(s), ${report.incompletePaths} incomplete path(s)`,
  ];
  for (const resource of report.resources) {
    const effects =
      resource.sideEffects
        .map((sideEffect) => `${sideEffect.kind} (${sideEffect.severity})`)
        .join(", ") || "none";
    lines.push(
      `  resource ${resource.resourceId} via provider ${resource.providerId}: ${effects}${resource.sensitive ? " [sensitive]" : ""} (${resource.pathCount} complete path(s))`,
    );
  }
  lines.push("  Rules:");
  for (const rule of report.rules)
    lines.push(`    ${rule.ruleId}: ${rule.explanation}`);
  lines.push(`  Note: ${report.heuristicNote}`);
  return lines.join("\n");
}

export function formatRoiReport(report: RoiReport): string {
  const lines = [
    `ROI report for tenant ${report.tenantId} at ${report.generatedAt} (${report.basis})`,
  ];
  lines.push(
    `  Active agents: ${report.activeAgentCount}; production providers: ${report.productionProviderCount}`,
  );
  lines.push(
    `  Incidents: prevented egress attempts ${report.incidents.preventedEgressAttempts}${report.incidents.preventedEgressSources.length === 0 ? " (not measured)" : ""}`,
  );
  lines.push(
    `  Review time: ${report.incidents.reviewTimeMinutes === null ? "not measured" : `${report.incidents.reviewTimeMinutes} minutes`}`,
  );
  lines.push(
    `  Mean time to contain: ${report.incidents.meanTimeToContainMinutes === null ? "not measured" : `${report.incidents.meanTimeToContainMinutes} minutes`}`,
  );
  lines.push(
    `  Remediation outcomes: unused grants removed ${report.remediationOutcomes.unusedGrantsRemoved}, scope reductions ${report.remediationOutcomes.excessiveScopeReductions}, owned grants ${report.remediationOutcomes.ownedGrants}, onboarded agents ${report.remediationOutcomes.onboardedAgents}, evals created ${report.remediationOutcomes.evalsCreated}`,
  );
  lines.push(
    `  Coverage: policy ${report.coverage.policyCoverageBps} bps, evidence ${report.coverage.evidenceCoverageBps} bps, gateway ${report.coverage.gatewayCoverageBps} bps, kill switch ${report.coverage.killSwitchCoverageBps} bps`,
  );
  if (report.notMeasured.length > 0)
    lines.push(`  Not measured: ${report.notMeasured.join(", ")}`);
  return lines.join("\n");
}

export function formatRemovalAnalysis(report: RemovalAnalysis): string {
  const lines = [
    `Removal analysis for tenant ${report.tenantId} at ${report.generatedAt} (${report.basis})`,
  ];
  const coverage = report.coverage;
  lines.push(
    `  Coverage: policy ${coverage.policyCoverageBps} bps, evidence ${coverage.evidenceCoverageBps} bps, gateway ${coverage.gatewayCoverageBps} bps, kill switch ${coverage.killSwitchCoverageBps} bps`,
  );
  lines.push(
    `  Direct credentials: ${coverage.directCredentials}; outside-gateway agents: ${coverage.outsideGatewayAgents}; unowned production: ${coverage.unownedProduction}`,
  );
  if (report.lostWithoutGhostApi.length === 0)
    lines.push(
      "  (no verifiable value currently depends on GhostAPI in this inventory)",
    );
  for (const statement of report.lostWithoutGhostApi)
    lines.push(`  - ${statement}`);
  return lines.join("\n");
}

class ImportedRecords {
  readonly agentIds = new Set<string>();
  readonly toolIds = new Set<string>();
  readonly identityIds = new Set<string>();
  readonly providerIds = new Set<string>();
  readonly resourceIds = new Set<string>();
  readonly sideEffectIds = new Set<string>();
  readonly credentialIds = new Set<string>();
  readonly policyIds = new Set<string>();
  constructor(payload: InventoryImportPayload) {
    for (const record of payload.agents ?? [])
      this.agentIds.add(record.agentId);
    for (const record of payload.tools ?? []) this.toolIds.add(record.toolId);
    for (const record of payload.identities ?? [])
      this.identityIds.add(record.identityId);
    for (const record of payload.providers ?? [])
      this.providerIds.add(record.providerId);
    for (const record of payload.resources ?? [])
      this.resourceIds.add(record.resourceId);
    for (const record of payload.sideEffects ?? [])
      this.sideEffectIds.add(record.sideEffectId);
    for (const record of payload.credentials ?? [])
      this.credentialIds.add(record.credentialId);
    for (const record of payload.policies ?? [])
      this.policyIds.add(record.policyId);
  }
}

function validateCrossReferences(
  state: InventoryStoreState,
  tenantId: string,
  imported: ImportedRecords,
): void {
  const has = (
    kind:
      | "agent"
      | "tool"
      | "identity"
      | "provider"
      | "resource"
      | "side_effect"
      | "credential"
      | "policy",
    id: string,
  ): boolean => {
    if (kind === "agent")
      return (
        imported.agentIds.has(id) ||
        state.agents.some(
          (record) => record.tenantId === tenantId && record.agentId === id,
        )
      );
    if (kind === "tool")
      return (
        imported.toolIds.has(id) ||
        state.tools.some(
          (record) => record.tenantId === tenantId && record.toolId === id,
        )
      );
    if (kind === "identity")
      return (
        imported.identityIds.has(id) ||
        state.identities.some(
          (record) => record.tenantId === tenantId && record.identityId === id,
        )
      );
    if (kind === "provider")
      return (
        imported.providerIds.has(id) ||
        state.providers.some(
          (record) => record.tenantId === tenantId && record.providerId === id,
        )
      );
    if (kind === "resource")
      return (
        imported.resourceIds.has(id) ||
        state.resources.some(
          (record) => record.tenantId === tenantId && record.resourceId === id,
        )
      );
    if (kind === "side_effect")
      return (
        imported.sideEffectIds.has(id) ||
        state.sideEffects.some(
          (record) =>
            record.tenantId === tenantId && record.sideEffectId === id,
        )
      );
    if (kind === "credential")
      return (
        imported.credentialIds.has(id) ||
        state.credentials.some(
          (record) =>
            record.tenantId === tenantId && record.credentialId === id,
        )
      );
    return (
      imported.policyIds.has(id) ||
      state.policies.some(
        (record) => record.tenantId === tenantId && record.policyId === id,
      )
    );
  };
  for (const agent of importedAgents(state, tenantId)) {
    for (const identityId of agent.identityIds)
      if (!has("identity", identityId))
        throw new InventoryError(
          `Agent ${agent.agentId} references unknown identity ${identityId}.`,
        );
  }
  for (const identity of importedIdentities(state, tenantId)) {
    for (const toolId of identity.toolIds)
      if (!has("tool", toolId))
        throw new InventoryError(
          `Identity ${identity.identityId} references unknown tool ${toolId}.`,
        );
  }
  for (const tool of importedTools(state, tenantId)) {
    if (tool.providerId !== null && !has("provider", tool.providerId))
      throw new InventoryError(
        `Tool ${tool.toolId} references unknown provider ${tool.providerId}.`,
      );
    for (const credentialId of tool.credentialIds)
      if (!has("credential", credentialId))
        throw new InventoryError(
          `Tool ${tool.toolId} references unknown credential ${credentialId}.`,
        );
  }
  for (const provider of importedProviders(state, tenantId)) {
    for (const resourceId of provider.resourceIds)
      if (!has("resource", resourceId))
        throw new InventoryError(
          `Provider ${provider.providerId} references unknown resource ${resourceId}.`,
        );
  }
  for (const resource of importedResources(state, tenantId)) {
    for (const sideEffectId of resource.sideEffectIds)
      if (!has("side_effect", sideEffectId))
        throw new InventoryError(
          `Resource ${resource.resourceId} references unknown side effect ${sideEffectId}.`,
        );
  }
  for (const sideEffect of importedSideEffects(state, tenantId)) {
    if (!has("resource", sideEffect.resourceId))
      throw new InventoryError(
        `Side effect ${sideEffect.sideEffectId} references unknown resource ${sideEffect.resourceId}.`,
      );
  }
  for (const credential of importedCredentials(state, tenantId)) {
    if (!has("provider", credential.providerId))
      throw new InventoryError(
        `Credential ${credential.credentialId} references unknown provider ${credential.providerId}.`,
      );
    for (const toolId of credential.toolIds)
      if (!has("tool", toolId))
        throw new InventoryError(
          `Credential ${credential.credentialId} references unknown tool ${toolId}.`,
        );
  }
}

function importedAgents(
  state: InventoryStoreState,
  tenantId: string,
): { agentId: string; identityIds: string[] }[] {
  return state.agents
    .filter((record) => record.tenantId === tenantId)
    .map((record) => ({
      agentId: record.agentId,
      identityIds: record.identityIds,
    }));
}
function importedIdentities(
  state: InventoryStoreState,
  tenantId: string,
): { identityId: string; toolIds: string[] }[] {
  return state.identities
    .filter((record) => record.tenantId === tenantId)
    .map((record) => ({
      identityId: record.identityId,
      toolIds: record.toolIds,
    }));
}
function importedTools(
  state: InventoryStoreState,
  tenantId: string,
): { toolId: string; providerId: string | null; credentialIds: string[] }[] {
  return state.tools
    .filter((record) => record.tenantId === tenantId)
    .map((record) => ({
      toolId: record.toolId,
      providerId: record.providerId,
      credentialIds: record.credentialIds,
    }));
}
function importedProviders(
  state: InventoryStoreState,
  tenantId: string,
): { providerId: string; resourceIds: string[] }[] {
  return state.providers
    .filter((record) => record.tenantId === tenantId)
    .map((record) => ({
      providerId: record.providerId,
      resourceIds: record.resourceIds,
    }));
}
function importedResources(
  state: InventoryStoreState,
  tenantId: string,
): { resourceId: string; sideEffectIds: string[] }[] {
  return state.resources
    .filter((record) => record.tenantId === tenantId)
    .map((record) => ({
      resourceId: record.resourceId,
      sideEffectIds: record.sideEffectIds,
    }));
}
function importedSideEffects(
  state: InventoryStoreState,
  tenantId: string,
): { sideEffectId: string; resourceId: string }[] {
  return state.sideEffects
    .filter((record) => record.tenantId === tenantId)
    .map((record) => ({
      sideEffectId: record.sideEffectId,
      resourceId: record.resourceId,
    }));
}
function importedCredentials(
  state: InventoryStoreState,
  tenantId: string,
): { credentialId: string; providerId: string; toolIds: string[] }[] {
  return state.credentials
    .filter((record) => record.tenantId === tenantId)
    .map((record) => ({
      credentialId: record.credentialId,
      providerId: record.providerId,
      toolIds: record.toolIds,
    }));
}

function upsertAgent(
  state: InventoryStoreState,
  tenantId: string,
  input: ImportedAgent,
  payload: InventoryImportPayload,
  importedBy: string,
  now: string,
): void {
  const record = {
    schemaVersion: 1,
    kind: "ghostapi.inventory-agent",
    tenantId,
    agentId: input.agentId,
    name: input.name,
    ownerId: input.ownerId === undefined ? null : input.ownerId,
    ...(input.businessPurpose === undefined
      ? {}
      : { businessPurpose: input.businessPurpose }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    ...(input.version === undefined ? {} : { version: input.version }),
    identityIds: input.identityIds,
    environmentIds: input.environmentIds,
    gatewayManaged: input.gatewayManaged,
    killSwitchEnabled: input.killSwitchEnabled,
    lastEvidenceAt:
      input.lastEvidenceAt === undefined ? null : input.lastEvidenceAt,
  } as const;
  merge(
    state,
    "agent",
    input.agentId,
    tenantId,
    record,
    payload.source,
    importedBy,
    now,
  );
}

function upsertTool(
  state: InventoryStoreState,
  tenantId: string,
  input: ImportedTool,
  payload: InventoryImportPayload,
  importedBy: string,
  now: string,
): void {
  const record = {
    schemaVersion: 1,
    tenantId,
    toolId: input.toolId,
    name: input.name,
    kind: input.kind,
    providerId: input.providerId === undefined ? null : input.providerId,
    requiredScopes: input.requiredScopes,
    credentialIds: input.credentialIds,
  } as const;
  merge(
    state,
    "tool",
    input.toolId,
    tenantId,
    record,
    payload.source,
    importedBy,
    now,
  );
}

function upsertIdentity(
  state: InventoryStoreState,
  tenantId: string,
  input: ImportedIdentity,
  payload: InventoryImportPayload,
  importedBy: string,
  now: string,
): void {
  const record = {
    schemaVersion: 1,
    kind: "ghostapi.inventory-identity",
    tenantId,
    identityId: input.identityId,
    principalId: input.principalId,
    role: input.role,
    agentId: input.agentId === undefined ? null : input.agentId,
    toolIds: input.toolIds,
    environmentIds: input.environmentIds,
    scopes: input.scopes,
  } as const;
  merge(
    state,
    "identity",
    input.identityId,
    tenantId,
    record,
    payload.source,
    importedBy,
    now,
  );
}

function upsertProvider(
  state: InventoryStoreState,
  tenantId: string,
  input: ImportedProvider,
  payload: InventoryImportPayload,
  importedBy: string,
  now: string,
): void {
  const record = {
    schemaVersion: 1,
    kind: "ghostapi.inventory-provider",
    tenantId,
    providerId: input.providerId,
    name: input.name,
    providerType: input.providerType,
    ownerId: input.ownerId === undefined ? null : input.ownerId,
    environmentIds: input.environmentIds,
    resourceIds: input.resourceIds,
    gatewayBound: input.gatewayBound,
    killSwitchApplied: input.killSwitchApplied,
  } as const;
  merge(
    state,
    "provider",
    input.providerId,
    tenantId,
    record,
    payload.source,
    importedBy,
    now,
  );
}

function upsertResource(
  state: InventoryStoreState,
  tenantId: string,
  input: ImportedResource,
  payload: InventoryImportPayload,
  importedBy: string,
  now: string,
): void {
  const record = {
    schemaVersion: 1,
    kind: "ghostapi.inventory-resource",
    tenantId,
    resourceId: input.resourceId,
    providerId: input.providerId,
    resourceType: input.resourceType,
    name: input.name,
    environmentIds: input.environmentIds,
    sensitive: input.sensitive,
    ownerId: input.ownerId === undefined ? null : input.ownerId,
    ...(input.businessPurpose === undefined
      ? {}
      : { businessPurpose: input.businessPurpose }),
    sideEffectIds: input.sideEffectIds,
  } as const;
  merge(
    state,
    "resource",
    input.resourceId,
    tenantId,
    record,
    payload.source,
    importedBy,
    now,
  );
}

function upsertSideEffect(
  state: InventoryStoreState,
  tenantId: string,
  input: ImportedSideEffect,
  payload: InventoryImportPayload,
  importedBy: string,
  now: string,
): void {
  const record = {
    schemaVersion: 1,
    tenantId,
    sideEffectId: input.sideEffectId,
    resourceId: input.resourceId,
    kind: input.kind,
    severity: input.severity,
  } as const;
  merge(
    state,
    "side_effect",
    input.sideEffectId,
    tenantId,
    record,
    payload.source,
    importedBy,
    now,
  );
}

function upsertCredential(
  state: InventoryStoreState,
  tenantId: string,
  input: ImportedCredential,
  payload: InventoryImportPayload,
  importedBy: string,
  now: string,
): void {
  const record = {
    schemaVersion: 1,
    kind: "ghostapi.inventory-credential",
    tenantId,
    credentialId: input.credentialId,
    name: input.name,
    providerId: input.providerId,
    ownerId: input.ownerId === undefined ? null : input.ownerId,
    environmentIds: input.environmentIds,
    grantScopes: input.grantScopes,
    toolIds: input.toolIds,
    status: input.status,
    issuedAt: input.issuedAt,
    lastUsedAt: input.lastUsedAt === undefined ? null : input.lastUsedAt,
    ...(input.rotatedAt === undefined ? {} : { rotatedAt: input.rotatedAt }),
    gatewayBound: input.gatewayBound,
  } as const;
  merge(
    state,
    "credential",
    input.credentialId,
    tenantId,
    record,
    payload.source,
    importedBy,
    now,
  );
}

function upsertPolicy(
  state: InventoryStoreState,
  tenantId: string,
  input: ImportedPolicy,
  payload: InventoryImportPayload,
  importedBy: string,
  now: string,
): void {
  const record = {
    schemaVersion: 1,
    kind: "ghostapi.inventory-policy",
    tenantId,
    policyId: input.policyId,
    name: input.name,
    version: input.version,
    hash: input.hash,
    environmentIds: input.environmentIds,
  } as const;
  merge(
    state,
    "policy",
    input.policyId,
    tenantId,
    record,
    payload.source,
    importedBy,
    now,
  );
}

type InventoryRecordKind =
  | "agent"
  | "tool"
  | "identity"
  | "provider"
  | "resource"
  | "side_effect"
  | "credential"
  | "policy";

function merge(
  state: InventoryStoreState,
  kind: InventoryRecordKind,
  id: string,
  tenantId: string,
  record: Record<string, unknown>,
  source: InventoryImportPayload["source"],
  importedBy: string,
  now: string,
): void {
  const list = recordList(state, kind);
  const index = list.findIndex(
    (candidate) =>
      candidate.tenantId === tenantId && idForKind(kind, candidate) === id,
  );
  const provenance = buildRecordProvenance(source, now, importedBy);
  const freshness = buildRecordFreshness(now);
  const stored = { ...record, provenance, freshness };
  if (index === -1) {
    if (list.length >= recordLimit(kind))
      throw new InventoryError(`${kind} record limit was reached.`);
    list.push(stored);
  } else {
    const prior = list[index] as { freshness?: RecordFreshness };
    const mergedFreshness = {
      firstSeenAt: prior.freshness?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    list[index] = { ...stored, freshness: mergedFreshness, provenance };
  }
}

function idForKind(
  kind: InventoryRecordKind,
  record: Record<string, unknown>,
): string {
  switch (kind) {
    case "agent":
      return typeof record.agentId === "string" ? record.agentId : "";
    case "tool":
      return typeof record.toolId === "string" ? record.toolId : "";
    case "identity":
      return typeof record.identityId === "string" ? record.identityId : "";
    case "provider":
      return typeof record.providerId === "string" ? record.providerId : "";
    case "resource":
      return typeof record.resourceId === "string" ? record.resourceId : "";
    case "side_effect":
      return typeof record.sideEffectId === "string" ? record.sideEffectId : "";
    case "credential":
      return typeof record.credentialId === "string" ? record.credentialId : "";
    case "policy":
      return typeof record.policyId === "string" ? record.policyId : "";
  }
}

function recordLimit(kind: InventoryRecordKind): number {
  switch (kind) {
    case "agent":
      return INVENTORY_LIMITS.maxAgents;
    case "tool":
      return INVENTORY_LIMITS.maxTools;
    case "identity":
      return INVENTORY_LIMITS.maxIdentities;
    case "provider":
      return INVENTORY_LIMITS.maxProviders;
    case "resource":
      return INVENTORY_LIMITS.maxResources;
    case "side_effect":
      return INVENTORY_LIMITS.maxSideEffects;
    case "credential":
      return INVENTORY_LIMITS.maxCredentials;
    case "policy":
      return INVENTORY_LIMITS.maxPolicies;
  }
}

function recordList(
  state: InventoryStoreState,
  kind: InventoryRecordKind,
): Array<Record<string, unknown>> {
  if (kind === "agent")
    return state.agents as unknown as Array<Record<string, unknown>>;
  if (kind === "tool")
    return state.tools as unknown as Array<Record<string, unknown>>;
  if (kind === "identity")
    return state.identities as unknown as Array<Record<string, unknown>>;
  if (kind === "provider")
    return state.providers as unknown as Array<Record<string, unknown>>;
  if (kind === "resource")
    return state.resources as unknown as Array<Record<string, unknown>>;
  if (kind === "side_effect")
    return state.sideEffects as unknown as Array<Record<string, unknown>>;
  if (kind === "credential")
    return state.credentials as unknown as Array<Record<string, unknown>>;
  return state.policies as unknown as Array<Record<string, unknown>>;
}

function upsertEdges(
  state: InventoryStoreState,
  tenantId: string,
  upserted: {
    kind:
      | "agent"
      | "tool"
      | "identity"
      | "provider"
      | "resource"
      | "side_effect"
      | "credential"
      | "policy";
    id: string;
  }[],
  payload: InventoryImportPayload,
  importedBy: string,
  now: string,
  before: Map<string, InventoryStoreState["edges"][number]>,
): ImportOutcome {
  const provenance = buildRecordProvenance(payload.source, now, importedBy);
  let edgesCreated = 0;
  let edgesRefreshed = 0;
  const apply = (
    sourceKind: InventoryStoreState["edges"][number]["sourceKind"],
    sourceId: string,
    targetKind: InventoryStoreState["edges"][number]["targetKind"],
    targetId: string,
    relation: InventoryStoreState["edges"][number]["relation"],
  ): void => {
    const edgeId = edgeIdFor(
      sourceKind,
      sourceId,
      targetKind,
      targetId,
      relation,
    );
    const prior = before.get(edgeId);
    if (prior === undefined) {
      state.edges.push({
        tenantId,
        edgeId,
        sourceKind,
        sourceId,
        targetKind,
        targetId,
        relation,
        provenance,
        firstSeenAt: now,
        lastSeenAt: now,
      });
      edgesCreated += 1;
    } else {
      state.edges = state.edges.map((edge) =>
        edge.edgeId === edgeId ? { ...edge, lastSeenAt: now } : edge,
      );
      edgesRefreshed += 1;
    }
  };
  for (const node of upserted) {
    if (node.kind === "agent") {
      const agent = state.agents.find(
        (record) => record.tenantId === tenantId && record.agentId === node.id,
      );
      if (agent === undefined) continue;
      for (const identityId of agent.identityIds)
        apply("agent", agent.agentId, "identity", identityId, "owns");
    } else if (node.kind === "identity") {
      const identity = state.identities.find(
        (record) =>
          record.tenantId === tenantId && record.identityId === node.id,
      );
      if (identity === undefined) continue;
      for (const toolId of identity.toolIds)
        apply("identity", identity.identityId, "tool", toolId, "uses");
    } else if (node.kind === "tool") {
      const tool = state.tools.find(
        (record) => record.tenantId === tenantId && record.toolId === node.id,
      );
      if (tool === undefined) continue;
      if (tool.providerId !== null)
        apply("tool", tool.toolId, "provider", tool.providerId, "connects");
      for (const credentialId of tool.credentialIds)
        apply("tool", tool.toolId, "credential", credentialId, "requires");
    } else if (node.kind === "provider") {
      const provider = state.providers.find(
        (record) =>
          record.tenantId === tenantId && record.providerId === node.id,
      );
      if (provider === undefined) continue;
      for (const resourceId of provider.resourceIds)
        apply(
          "provider",
          provider.providerId,
          "resource",
          resourceId,
          "exposes",
        );
    } else if (node.kind === "resource") {
      const resource = state.resources.find(
        (record) =>
          record.tenantId === tenantId && record.resourceId === node.id,
      );
      if (resource === undefined) continue;
      for (const sideEffectId of resource.sideEffectIds)
        apply(
          "resource",
          resource.resourceId,
          "side_effect",
          sideEffectId,
          "permits",
        );
    }
  }
  return {
    recordCounts: {
      agents: 0,
      tools: 0,
      identities: 0,
      providers: 0,
      resources: 0,
      sideEffects: 0,
      credentials: 0,
      policies: 0,
    },
    edgesCreated,
    edgesRefreshed,
  };
}

function snapshotFor(
  state: InventoryStoreState,
  tenantId: string,
  now: string,
  freshnessDays: InventoryFreshnessDays | undefined,
): InventorySnapshot {
  return {
    schemaVersion: 1,
    kind: "ghostapi.inventory-snapshot",
    tenantId,
    agents: clone(
      state.agents.filter((record) => record.tenantId === tenantId),
    ),
    tools: clone(state.tools.filter((record) => record.tenantId === tenantId)),
    identities: clone(
      state.identities.filter((record) => record.tenantId === tenantId),
    ),
    providers: clone(
      state.providers.filter((record) => record.tenantId === tenantId),
    ),
    resources: clone(
      state.resources.filter((record) => record.tenantId === tenantId),
    ),
    sideEffects: clone(
      state.sideEffects.filter((record) => record.tenantId === tenantId),
    ),
    credentials: clone(
      state.credentials.filter((record) => record.tenantId === tenantId),
    ),
    policies: clone(
      state.policies.filter((record) => record.tenantId === tenantId),
    ),
    edges: graphEdges(state, tenantId, now, freshnessDays),
    findings: clone(
      state.findings.filter((record) => record.tenantId === tenantId),
    ),
    remediations: clone(
      state.remediations.filter((record) => record.tenantId === tenantId),
    ),
    sources: clone(
      state.sources.filter((record) => record.tenantId === tenantId),
    ),
    importRuns: clone(
      state.importRuns.filter((record) => record.tenantId === tenantId),
    ),
  };
}

function applyRemediationEffect(
  state: InventoryStoreState,
  tenantId: string,
  remediation: InventoryStoreState["remediations"][number],
  now: string,
): void {
  const result = remediation.result;
  if (remediation.kind === "assign_owner") {
    if (result === undefined || result.ownerId === undefined)
      throw new InventoryError(
        "assign_owner remediation requires an owner id.",
      );
    if (remediation.targetKind === "agent") {
      const record = state.agents.find(
        (candidate) =>
          candidate.tenantId === tenantId &&
          candidate.agentId === remediation.targetId,
      );
      if (record === undefined)
        throw new InventoryError("Remediation target agent does not exist.");
      record.ownerId = result.ownerId;
    } else if (remediation.targetKind === "provider") {
      const record = state.providers.find(
        (candidate) =>
          candidate.tenantId === tenantId &&
          candidate.providerId === remediation.targetId,
      );
      if (record === undefined)
        throw new InventoryError("Remediation target provider does not exist.");
      record.ownerId = result.ownerId;
    } else if (remediation.targetKind === "resource") {
      const record = state.resources.find(
        (candidate) =>
          candidate.tenantId === tenantId &&
          candidate.resourceId === remediation.targetId,
      );
      if (record === undefined)
        throw new InventoryError("Remediation target resource does not exist.");
      record.ownerId = result.ownerId;
    } else if (remediation.targetKind === "credential") {
      const record = state.credentials.find(
        (candidate) =>
          candidate.tenantId === tenantId &&
          candidate.credentialId === remediation.targetId,
      );
      if (record === undefined)
        throw new InventoryError(
          "Remediation target credential does not exist.",
        );
      record.ownerId = result.ownerId;
    } else {
      throw new InventoryError(
        "assign_owner remediation only supports agent, provider, resource, or credential targets.",
      );
    }
  } else if (remediation.kind === "reduce_scope") {
    if (remediation.targetKind !== "credential")
      throw new InventoryError(
        "reduce_scope remediation only supports credential targets.",
      );
    if (result === undefined || result.reducedScopes === undefined)
      throw new InventoryError(
        "reduce_scope remediation requires the reduced scope list.",
      );
    const record = state.credentials.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.credentialId === remediation.targetId,
    );
    if (record === undefined)
      throw new InventoryError("Remediation target credential does not exist.");
    if (record.status !== "active")
      throw new InventoryError("Cannot reduce scopes on a revoked credential.");
    const current = record.grantScopes;
    const reduced = result.reducedScopes;
    for (const scope of reduced)
      if (!current.includes(scope))
        throw new InventoryError(
          "Reduced scopes must be a subset of the current grant scopes; permissions are never expanded.",
        );
    if (reduced.length >= current.length)
      throw new InventoryError(
        "reduce_scope must remove at least one scope; permissions are never expanded.",
      );
    record.grantScopes = reduced;
  } else if (remediation.kind === "revoke") {
    if (remediation.targetKind !== "credential")
      throw new InventoryError(
        "revoke remediation only supports credential targets.",
      );
    const record = state.credentials.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.credentialId === remediation.targetId,
    );
    if (record === undefined)
      throw new InventoryError("Remediation target credential does not exist.");
    record.status = "revoked";
  } else if (remediation.kind === "onboard_through_gateway") {
    if (remediation.targetKind !== "agent")
      throw new InventoryError(
        "onboard_through_gateway remediation only supports agent targets.",
      );
    const record = state.agents.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.agentId === remediation.targetId,
    );
    if (record === undefined)
      throw new InventoryError("Remediation target agent does not exist.");
    record.gatewayManaged = true;
    record.freshness = { ...record.freshness, lastSeenAt: now };
  } else if (remediation.kind === "create_eval") {
    if (remediation.targetKind !== "agent")
      throw new InventoryError(
        "create_eval remediation only supports agent targets.",
      );
    if (result === undefined || result.evalScenarioId === undefined)
      throw new InventoryError(
        "create_eval remediation requires an eval scenario id.",
      );
    if (
      !state.agents.some(
        (record) =>
          record.tenantId === tenantId &&
          record.agentId === remediation.targetId,
      )
    )
      throw new InventoryError("Remediation target agent does not exist.");
  }
}

function remediationResult(
  proposal: {
    ownerId?: string;
    reducedScopes?: string[];
    evalScenarioId?: string;
  },
  proposedBy: string,
): NonNullable<InventoryStoreState["remediations"][number]["result"]> {
  return {
    description: `Proposed by ${proposedBy}`,
    ...(proposal.ownerId === undefined ? {} : { ownerId: proposal.ownerId }),
    ...(proposal.reducedScopes === undefined
      ? {}
      : { reducedScopes: proposal.reducedScopes }),
    ...(proposal.evalScenarioId === undefined
      ? {}
      : { evalScenarioId: proposal.evalScenarioId }),
  };
}

function validateRemediationProposal(value: unknown): {
  findingId: string;
  kind: InventoryStoreState["remediations"][number]["kind"];
  targetKind: InventoryStoreState["remediations"][number]["targetKind"];
  targetId: string;
  rationale: string;
  ownerId?: string;
  reducedScopes?: string[];
  evalScenarioId?: string;
} {
  const proposal = object(value, "Remediation proposal must be an object.");
  exactKeys(
    proposal,
    [
      "findingId",
      "kind",
      "targetKind",
      "targetId",
      "rationale",
      "ownerId",
      "reducedScopes",
      "evalScenarioId",
    ],
    "remediation proposal",
    ["ownerId", "reducedScopes", "evalScenarioId"],
  );
  const kind = proposal.kind;
  if (
    ![
      "assign_owner",
      "reduce_scope",
      "revoke",
      "onboard_through_gateway",
      "create_eval",
    ].includes(kind as string)
  )
    throw new InventoryError("Remediation kind is invalid.");
  const targetKind = proposal.targetKind;
  if (
    ![
      "agent",
      "identity",
      "tool",
      "provider",
      "resource",
      "side_effect",
      "credential",
      "environment",
      "policy",
    ].includes(targetKind as string)
  )
    throw new InventoryError("Remediation target kind is invalid.");
  const result: {
    findingId: string;
    kind: InventoryStoreState["remediations"][number]["kind"];
    targetKind: InventoryStoreState["remediations"][number]["targetKind"];
    targetId: string;
    rationale: string;
    ownerId?: string;
    reducedScopes?: string[];
    evalScenarioId?: string;
  } = {
    findingId: safeIdentifier(proposal.findingId, "Remediation finding id"),
    kind: kind as InventoryStoreState["remediations"][number]["kind"],
    targetKind:
      targetKind as InventoryStoreState["remediations"][number]["targetKind"],
    targetId: safeIdentifier(proposal.targetId, "Remediation target id"),
    rationale: safeText(proposal.rationale, "Remediation rationale", 400),
  };
  if (proposal.ownerId !== undefined)
    result.ownerId = safeIdentifier(proposal.ownerId, "Remediation owner id");
  if (proposal.reducedScopes !== undefined)
    result.reducedScopes = safeScopes(
      proposal.reducedScopes,
      "Remediation reduced scopes",
    );
  if (proposal.evalScenarioId !== undefined)
    result.evalScenarioId = safeIdentifier(
      proposal.evalScenarioId,
      "Remediation eval scenario id",
    );
  if (result.kind === "assign_owner" && result.ownerId === undefined)
    throw new InventoryError("assign_owner remediation requires an owner id.");
  if (result.kind === "reduce_scope" && result.reducedScopes === undefined)
    throw new InventoryError(
      "reduce_scope remediation requires the reduced scope list.",
    );
  if (result.kind === "create_eval" && result.evalScenarioId === undefined)
    throw new InventoryError(
      "create_eval remediation requires an eval scenario id.",
    );
  return result;
}

function safeIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value) ||
    sanitizeSecretString(value) !== value
  )
    throw new InventoryError(`${label} must be a safe identifier.`);
  return value;
}

function safeScopes(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > INVENTORY_LIMITS.maxScopesPerRecord
  )
    throw new InventoryError(`${label} is invalid.`);
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !/^[a-z0-9][a-z0-9._:\-]{0,127}$/.test(entry) ||
      sanitizeSecretString(entry) !== entry
    )
      throw new InventoryError(`${label} must be safe scope identifiers.`);
    return entry;
  });
}

function safeText(value: unknown, label: string, max: number): string {
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

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new InventoryError(message);
  return value as Record<string, unknown>;
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

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
