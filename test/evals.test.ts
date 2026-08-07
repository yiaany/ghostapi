import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDataPaths } from "../src/config/dataPaths.js";
import { buildEvidenceReport, generateEvidenceReport } from "../src/evidence/index.js";
import { builtinEvalTemplates, formatEvalReport, loadEvalSpec, runEval, scoreEval, type EvalSpec } from "../src/evals/index.js";
import type { ProxyEvent } from "../src/server/eventsStore.js";

describe("agent evals", () => {
  it("scores deterministic evidence with a stable logical hash", () => {
    const evidence = evidenceFixture();
    const first = scoreEval(builtinEvalTemplates["retry-after"], evidence, { generatedAt: "2026-08-07T00:00:00.000Z", evidencePath: ".ghostapi/reports/evidence.json" });
    const second = scoreEval(builtinEvalTemplates["retry-after"], evidence, { generatedAt: "2026-08-08T00:00:00.000Z", evidencePath: ".ghostapi/reports/evidence.json" });

    expect(first.score.core).toBe(100);
    expect(first.score.passed).toBe(true);
    expect(first.artifact.logicalHash).toBe(second.artifact.logicalHash);
    expect(first.repeatability.evidenceLogicalHash).toBe(evidence.artifact.logicalHash);
  });

  it("gives forbidden actions priority over cosmetic success", () => {
    const evidence = { ...evidenceFixture(), egress: { ...evidenceFixture().egress, productionAttempts: 1 } };
    const report = scoreEval(builtinEvalTemplates["no-production-bypass"], evidence, { generatedAt: "2026-08-07T00:00:00.000Z" });

    expect(report.score.forbiddenTriggered).toEqual(["production-egress"]);
    expect(report.score.core).toBe(0);
    expect(report.score.passed).toBe(false);
  });

  it("does not include raw secrets in eval reports", () => {
    const evidence = buildEvidenceReport({ events: [{ ...eventFixture(), request: { headers: { authorization: "Bearer sk_live_secret" }, body: { scenario: "security.no_secret_logs" } } }], runEvidence: runEvidenceFixture(), generatedAt: "2026-08-07T00:00:00.000Z" });
    const report = scoreEval(builtinEvalTemplates["no-secret-logs"], evidence, { generatedAt: "2026-08-07T00:00:00.000Z" });
    const serialized = JSON.stringify(report);

    expect(report.score.forbiddenTriggered).toEqual(["secret-leak"]);
    expect(serialized).not.toContain("sk_live_secret");
    expect(serialized).not.toContain("Bearer");
    expect(formatEvalReport(report)).not.toContain("sk_live_secret");
  });

  it("loads strict data-only JSON specs and rejects unknown executable fields", async () => {
    await mkdir(getDataPaths().root, { recursive: true });
    const specPath = join(getDataPaths().root, "custom.eval.json");
    await writeFile(specPath, JSON.stringify(customSpec()), "utf8");
    await expect(loadEvalSpec(specPath)).resolves.toMatchObject({ id: "custom.retry" });

    const maliciousPath = join(getDataPaths().root, "malicious.eval.json");
    await writeFile(maliciousPath, JSON.stringify({ ...customSpec(), hooks: { afterRun: "curl https://example.com" } }), "utf8");
    await expect(loadEvalSpec(maliciousPath)).rejects.toThrow("Unknown eval spec field");
  });

  it("runs offline scoring from a prebuilt evidence artifact", async () => {
    const evidencePath = join(getDataPaths().reports, "eval-evidence.json");
    await generateEvidenceReport({ outPath: evidencePath, generatedAt: "2026-08-07T00:00:00.000Z", ghostApiVersion: "0.0.0-test" });

    const { report, path } = await runEval({ template: "no-production-bypass", evidencePath, generatedAt: "2026-08-07T00:00:00.000Z" });

    expect(path).toContain("no-production-bypass.eval.json");
    expect(report.evidence.links).toEqual([evidencePath]);
    expect(report.judge.used).toBe(false);
  });
});

function customSpec(): EvalSpec {
  return {
    schemaVersion: 1,
    kind: "ghostapi.eval",
    id: "custom.retry",
    title: "Custom retry eval",
    syntheticWorld: { providers: ["stripe"], scenarios: ["stripe.rate_limited"] },
    task: { description: "Run custom agent", command: ["node", "agent.mjs"] },
    injectedFailures: [{ id: "stripe.rate_limited", type: "rate-limit", provider: "stripe", statusCode: 429, retryAfterMs: 1000 }],
    expectations: [{ id: "retry", type: "retry-observed", points: 100 }],
    forbidden: [{ id: "production-egress", type: "production-egress" }],
    limits: { timeoutMs: 1000, maxOutputBytes: 1024 },
    rubric: { maxScore: 100, components: [{ id: "retry", expectationId: "retry", points: 100, reason: "Retry observed." }] },
    judge: { llmAsJudge: false }
  };
}

function evidenceFixture() {
  return buildEvidenceReport({ events: [eventFixture()], runEvidence: runEvidenceFixture(), generatedAt: "2026-08-07T00:00:00.000Z", ghostApiVersion: "0.0.0-test" });
}

function eventFixture(): ProxyEvent {
  return {
    id: "evt_1",
    timestamp: "2026-08-07T00:00:01.000Z",
    provider: "stripe",
    method: "POST",
    path: "/v1/payment_intents",
    statusCode: 200,
    source: "state",
    durationMs: 12,
    request: { body: { scenario: "stripe.rate_limited" } },
    response: { headers: { "retry-after": "2" } }
  };
}

function runEvidenceFixture() {
  return {
    schemaVersion: 1,
    runId: "run_1",
    backend: "linux-network-namespace",
    status: "finished",
    policy: { policyHash: "a".repeat(64), requiredScenarios: [] },
    events: [
      { type: "run-created", timestamp: "2026-08-07T00:00:00.000Z" },
      { type: "target-exited", timestamp: "2026-08-07T00:00:02.000Z", exitCode: 0 }
    ]
  };
}
