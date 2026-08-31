import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { getDataPaths } from "../src/config/dataPaths.js";
import {
  buildEvidenceReport,
  compareEvidenceReports,
  formatEvidenceReport,
  generateEvidenceReport,
  loadEvidenceReport,
} from "../src/evidence/index.js";
import { parsePolicyYaml } from "../src/policy/index.js";
import {
  addEvent,
  clearEvents,
  type ProxyEvent,
} from "../src/server/eventsStore.js";
import { diffContracts } from "../src/contracts/index.js";

const cliPath = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

const POLICY = parsePolicyYaml(`version: 1
network:
  default: deny
  allow:
    - host: localhost
  deny: []
  productionHosts:
    - '*.stripe.com'
credentials:
  forbid:
    - sk_live_*
requiredScenarios:
  - stripe.card_declined
enforcement:
  allowedModes:
    - linux-network-namespace
reports:
  maxProductionEgressAttempts: 0
  maxForbiddenCredentialMatches: 0
`);

describe("evidence reports", () => {
  beforeEach(async () => {
    await clearEvents();
  });

  it("builds a redacted versioned report with policy findings and no raw secrets", () => {
    const report = buildEvidenceReport({
      events: [eventFixture()],
      policy: POLICY,
      policyHash: "a".repeat(64),
      requiredScenarios: ["stripe.card_declined"],
      runEvidence: runEvidenceFixture(),
      generatedAt: "2026-08-07T00:00:00.000Z",
      ghostApiVersion: "0.0.0-test",
    });
    const serialized = JSON.stringify(report);

    expect(report.schemaVersion).toBe(1);
    expect(report.artifact.logicalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.policy.hash).toBe("a".repeat(64));
    expect(report.coverage.providers).toEqual(["stripe"]);
    expect(report.coverage.scenarios).toEqual(["stripe.card_declined"]);
    expect(report.egress.productionAttempts).toBeNull();
    expect(report.warnings).toContain(
      "Production egress attempts are not measured; the current backend records namespace lifecycle and GhostAPI-local traffic only.",
    );
    expect(report.secrets.categories).toContain("authorization-header");
    expect(report.secrets.categories).toContain("stripe-live-key");
    expect(report.egress.allowedAttempts[0]?.path).toBe(
      "/v1/payment_intents?api_key=***&safe=1",
    );
    expect(serialized).not.toContain("sk_live_secret");
    expect(serialized).not.toContain("Bearer live-token");
    expect(serialized).not.toContain("session=secret-cookie");
  });

  it("keeps the logical hash deterministic for equivalent normalized events", () => {
    const first = buildEvidenceReport({
      events: [eventFixture()],
      runEvidence: runEvidenceFixture(),
      generatedAt: "2026-08-07T00:00:00.000Z",
      ghostApiVersion: "0.0.0-test",
    });
    const second = buildEvidenceReport({
      events: [eventFixture()],
      runEvidence: runEvidenceFixture(),
      generatedAt: "2026-08-08T00:00:00.000Z",
      ghostApiVersion: "0.0.0-test",
    });

    expect(first.artifact.logicalHash).toBe(second.artifact.logicalHash);
    expect(compareEvidenceReports(first, second)).toMatchObject({
      equal: true,
    });
  });

  it("writes, loads, validates, and rejects corrupted artifacts", async () => {
    await addEvent(eventFixture());
    const { report, path } = await generateEvidenceReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      ghostApiVersion: "0.0.0-test",
    });

    await expect(loadEvidenceReport(path)).resolves.toMatchObject({
      artifact: { logicalHash: report.artifact.logicalHash },
    });
    const corruptedPath = join(getDataPaths().reports, "corrupted.json");
    await writeFile(
      corruptedPath,
      JSON.stringify({
        ...report,
        summary: { ...report.summary, passed: !report.summary.passed },
      }),
      "utf8",
    );
    await expect(loadEvidenceReport(corruptedPath)).rejects.toThrow(
      "logical hash",
    );
  });

  it("uses the isolated run event log when a run evidence path is supplied", async () => {
    await addEvent({ ...eventFixture(), provider: "global" });
    const runDirectory = join(
      getDataPaths().root,
      "runs",
      "run-runtime-events",
    );
    const runtimeDirectory = join(runDirectory, "runtime");
    const runPath = join(runDirectory, "run.json");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(runPath, JSON.stringify(runEvidenceFixture()), "utf8");
    await writeFile(
      join(runtimeDirectory, "events.jsonl"),
      `${JSON.stringify({ ...eventFixture(), request: { body: { scenario: "ci.safe_ghostapi" } } })}\n`,
      "utf8",
    );

    const { report } = await generateEvidenceReport({
      runPath,
      generatedAt: "2026-08-07T00:00:00.000Z",
      ghostApiVersion: "0.0.0-test",
    });

    expect(report.coverage.providers).toEqual(["stripe"]);
    expect(report.coverage.scenarios).toEqual(["ci.safe_ghostapi"]);
    expect(report.egress.allowedAttempts).toHaveLength(1);
  });

  it("rejects output path traversal and strips terminal escapes in the human summary", async () => {
    await expect(
      generateEvidenceReport({ outPath: "../outside.json" }),
    ).rejects.toThrow("path traversal");
    const report = buildEvidenceReport({
      events: [{ ...eventFixture(), provider: "stripe\u001b[31m" }],
      runEvidence: runEvidenceFixture(),
      generatedAt: "2026-08-07T00:00:00.000Z",
    });

    expect(formatEvidenceReport(report)).not.toContain("\u001b");
  });

  it("bounds and validates explicit run evidence before parsing it", async () => {
    const invalidPath = join(getDataPaths().root, "invalid-run.json");
    const oversizedPath = join(getDataPaths().root, "oversized-run.json");
    await mkdir(getDataPaths().root, { recursive: true });
    await writeFile(invalidPath, "{not-json", "utf8");
    await writeFile(oversizedPath, "x".repeat(128 * 1024 + 1), "utf8");

    await expect(
      generateEvidenceReport({ runPath: invalidPath }),
    ).rejects.toThrow("Run evidence is not valid JSON.");
    await expect(
      generateEvidenceReport({ runPath: oversizedPath }),
    ).rejects.toThrow("Run evidence exceeds 131072 bytes.");
  });

  it("sets a non-zero CI exit code when policy findings fail", async () => {
    await addEvent(eventFixture());
    const outputPath = join(getDataPaths().reports, "ci.json");
    const result = await runCli([
      "evidence",
      "generate",
      "--policy",
      "test/fixtures/evidence-failing.policy.yaml",
      "--out",
      outputPath,
      "--ci",
      "--json",
    ]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      report: { summary: { passed: false } },
    });
  });

  it("includes contract drift in evidence and fails policy-controlled CI on breaking changes", () => {
    const report = buildEvidenceReport({
      events: [],
      policy: POLICY,
      contractDiff: diffContracts(
        contract("Base", "integer"),
        contract("Head", "string"),
      ),
      runEvidence: runEvidenceFixture(),
      generatedAt: "2026-08-07T00:00:00.000Z",
    });

    expect(report.contractDrift.breaking).toBeGreaterThan(0);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "contract-drift.breaking",
          severity: "fail",
        }),
      ]),
    );
    expect(report.summary.passed).toBe(false);
  });
});

function contract(title: string, amountType: "integer" | "string") {
  return {
    schemaVersion: 1 as const,
    kind: "ghostapi.contract" as const,
    metadata: {
      title,
      source: "openapi" as const,
      importedAt: "2026-08-07T00:00:00.000Z",
    },
    operations: [
      {
        method: "POST",
        path: "/orders",
        request: {
          type: "object",
          properties: { amount: { type: amountType } },
        },
        responses: { "200": { type: "object" } },
      },
    ],
    providerCapabilities: [],
  };
}

function eventFixture(): ProxyEvent {
  return {
    id: "evt_1",
    timestamp: "2026-08-07T00:00:01.000Z",
    provider: "stripe",
    method: "POST",
    path: "/v1/payment_intents?api_key=sk_live_secret&safe=1",
    statusCode: 402,
    source: "state",
    durationMs: 12,
    request: {
      headers: {
        authorization: "Bearer live-token",
        cookie: "session=secret-cookie",
      },
      body: {
        metadata: { scenario: "stripe.card_declined" },
        nested: { client_secret: "sk_live_secret" },
      },
    },
    response: { error: { code: "card_declined" }, retryAfter: 2 },
  };
}

function runEvidenceFixture() {
  return {
    schemaVersion: 1,
    runId: "run_1",
    backend: "linux-network-namespace",
    status: "finished",
    policy: {
      policyHash: "a".repeat(64),
      requiredScenarios: ["stripe.card_declined"],
    },
    events: [
      { type: "run-created", timestamp: "2026-08-07T00:00:00.000Z" },
      {
        type: "target-exited",
        timestamp: "2026-08-07T00:00:02.000Z",
        exitCode: 0,
      },
    ],
  };
}

function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr }),
    );
  });
}
