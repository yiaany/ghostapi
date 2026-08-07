import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { detectEgressCapabilities } from "../egress/capabilities.js";
import { evaluatePolicy, loadPolicyFile, type GhostApiPolicy } from "../policy/index.js";
import { sanitizeSecrets, sanitizeSecretString, isSecretFieldName } from "../security/secrets.js";
import type { ProxyEvent } from "../server/eventsStore.js";
import { atomicWriteJson, ensurePrivateDirectory } from "../storage/fileStore.js";

export type EvidenceFindingSeverity = "pass" | "warning" | "fail";

export type EvidenceFinding = {
  id: string;
  severity: EvidenceFindingSeverity;
  message: string;
  count?: number;
};

export type EvidenceReport = {
  schemaVersion: 1;
  artifact: {
    generatedAt: string;
    logicalHash: string;
    canonicalization: "json-stable-sorted-keys-v1";
  };
  run: {
    id: string;
    status: "unknown" | "preparing" | "running" | "failed-to-start" | "finished";
    startedAt?: string;
    finishedAt?: string;
    exitCode?: number;
  };
  ghostapi: {
    version: string;
  };
  enforcement: {
    capability: string;
    mode: "linux-network-namespace" | "proxy-guidance" | "unknown";
    isolated: boolean;
    degraded: boolean;
  };
  policy: {
    hash?: string;
    requiredScenarios: string[];
  };
  coverage: {
    providers: string[];
    scenarios: string[];
  };
  egress: {
    allowedAttempts: Array<{ provider: string; method: string; path: string; statusCode: number; source: string }>;
    blockedAttempts: Array<{ host: string; reason: string }>;
    productionAttempts: number;
  };
  secrets: {
    categories: string[];
    matches: number;
  };
  retriesAndFailures: {
    retryCount: number;
    failureCount: number;
    failures: Array<{ provider: string; method: string; path: string; statusCode: number }>;
  };
  findings: EvidenceFinding[];
  warnings: string[];
  summary: {
    passed: boolean;
    failCount: number;
    warningCount: number;
  };
};

export type EvidenceGenerateOptions = {
  projectRoot?: string;
  policyPath?: string;
  runPath?: string;
  outPath?: string;
  generatedAt?: string;
  ghostApiVersion?: string;
};

export type EvidenceCompareResult = {
  equal: boolean;
  leftHash: string;
  rightHash: string;
  differences: string[];
};

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version?: unknown };

const MAX_EVENTS_FOR_REPORT = 1_000;
const MAX_JSONL_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_REPORTS_RETAINED = 20;
const MAX_ATTEMPTS = 500;
const SENSITIVE_QUERY_KEYS = new Set(["api_key", "apikey", "access_token", "refresh_token", "token", "secret", "key", "client_secret", "password", "authorization", "cookie"]);

type RunEvidence = {
  schemaVersion?: unknown;
  runId?: unknown;
  backend?: unknown;
  status?: unknown;
  policy?: { policyHash?: unknown; requiredScenarios?: unknown };
  events?: Array<{ type?: unknown; timestamp?: unknown; exitCode?: unknown }>;
};

export class EvidenceReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceReportError";
  }
}

export async function generateEvidenceReport(options: EvidenceGenerateOptions = {}): Promise<{ report: EvidenceReport; path: string }> {
  const projectRoot = await realProjectRoot(options.projectRoot ?? process.cwd());
  const run = await readRunEvidence(options.runPath, projectRoot);
  const loadedPolicy = await loadPolicyFile(options.policyPath, projectRoot, options.policyPath !== undefined);
  const events = await readPersistedEvents(run?.path);
  const report = buildEvidenceReport({
    events,
    policy: loadedPolicy?.policy,
    policyHash: loadedPolicy?.hash ?? readString(run?.evidence.policy?.policyHash),
    requiredScenarios: loadedPolicy?.policy.requiredScenarios ?? readStringArray(run?.evidence.policy?.requiredScenarios),
    runEvidence: run?.evidence ?? null,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    ghostApiVersion: options.ghostApiVersion ?? readPackageVersion()
  });
  const path = await writeEvidenceReport(report, projectRoot, options.outPath);
  return { report, path };
}

export function buildEvidenceReport(input: {
  events: ProxyEvent[];
  policy?: GhostApiPolicy;
  policyHash?: string;
  requiredScenarios?: string[];
  runEvidence?: RunEvidence | null;
  generatedAt: string;
  ghostApiVersion?: string;
}): EvidenceReport {
  const sanitizedEvents = input.events.slice(0, MAX_EVENTS_FOR_REPORT).map((event) => sanitizeEvent(event));
  const capability = detectEgressCapabilities();
  const runEvents = Array.isArray(input.runEvidence?.events) ? input.runEvidence.events : [];
  const completedScenarios = detectScenarios(sanitizedEvents);
  const requiredScenarios = uniqueSorted(input.requiredScenarios ?? []);
  const providers = uniqueSorted(sanitizedEvents.map((event) => event.provider).filter(Boolean));
  const secretCategories = new Set<string>();
  let secretMatches = 0;

  for (const event of input.events) {
    const result = detectSecretCategories(event);
    for (const category of result.categories) secretCategories.add(category);
    secretMatches += result.matches;
  }

  const allowedAttempts = sanitizedEvents.map((event) => ({
    provider: limitText(event.provider),
    method: limitText(event.method),
    path: sanitizePath(event.path),
    statusCode: event.statusCode,
    source: limitText(event.source)
  })).slice(0, MAX_ATTEMPTS);
  const failures = allowedAttempts.filter((attempt) => attempt.statusCode >= 400).map((attempt) => ({ provider: attempt.provider, method: attempt.method, path: attempt.path, statusCode: attempt.statusCode }));
  const retryCount = sanitizedEvents.filter((event) => event.statusCode === 429 || hasRetryAfter(event)).length;
  const productionAttempts = 0;
  const findings: EvidenceFinding[] = [];
  const warnings: string[] = [];

  if (sanitizedEvents.length < input.events.length) warnings.push(`Event evidence was truncated to ${MAX_EVENTS_FOR_REPORT} events.`);
  if (input.runEvidence === null) warnings.push("Run evidence is missing; report cannot prove launcher lifecycle or blocked kernel egress attempts.");
  if (capability.isolated) findings.push({ id: "enforcement.isolated", severity: "pass", message: "Egress enforcement reports an isolated backend." });
  else findings.push({ id: "enforcement.degraded", severity: "warning", message: "Egress enforcement is degraded or unavailable on this host." });
  if (input.runEvidence?.status === "finished") findings.push({ id: "run.finished", severity: "pass", message: "Run evidence reached finished status." });
  else findings.push({ id: "run.incomplete", severity: "warning", message: "Run evidence is absent or incomplete." });
  for (const scenarioId of requiredScenarios) {
    const decision = input.policy === undefined ? { allowed: completedScenarios.includes(scenarioId) } : evaluatePolicy(input.policy, { type: "scenario", scenarioId, completedScenarioIds: completedScenarios });
    findings.push(decision.allowed
      ? { id: `scenario.${scenarioId}`, severity: "pass", message: `Required scenario completed: ${scenarioId}` }
      : { id: `scenario.${scenarioId}`, severity: "fail", message: `Required scenario missing: ${scenarioId}` });
  }
  const reportDecision = input.policy === undefined ? { allowed: productionAttempts === 0 && secretMatches === 0 } : evaluatePolicy(input.policy, { type: "report", productionEgressAttempts: productionAttempts, forbiddenCredentialMatches: secretMatches });
  findings.push(reportDecision.allowed
    ? { id: "policy.report-thresholds", severity: "pass", message: "Policy report thresholds are satisfied." }
    : { id: "policy.report-thresholds", severity: "fail", message: "Policy report thresholds are exceeded." });
  if (secretMatches > 0) findings.push({ id: "secrets.detected", severity: "fail", message: "Secret-shaped values were detected and summarized without raw values.", count: secretMatches });
  if (failures.length > 0) findings.push({ id: "provider.failures", severity: "warning", message: "Provider failures were observed.", count: failures.length });

  const runStatus = readRunStatus(input.runEvidence?.status);
  const reportWithoutHash: EvidenceReport = {
    schemaVersion: 1,
    artifact: { generatedAt: input.generatedAt, logicalHash: "", canonicalization: "json-stable-sorted-keys-v1" },
    run: {
      id: readString(input.runEvidence?.runId) ?? "unknown",
      status: runStatus,
      startedAt: firstTimestamp(runEvents),
      finishedAt: lastTimestamp(runEvents),
      exitCode: lastExitCode(runEvents)
    },
    ghostapi: { version: input.ghostApiVersion ?? "unknown" },
    enforcement: {
      capability: capability.summary,
      mode: input.runEvidence?.backend === "linux-network-namespace" ? "linux-network-namespace" : capability.isolated ? "linux-network-namespace" : "proxy-guidance",
      isolated: capability.isolated,
      degraded: !capability.isolated
    },
    policy: { hash: input.policyHash, requiredScenarios },
    coverage: { providers, scenarios: completedScenarios },
    egress: { allowedAttempts, blockedAttempts: [], productionAttempts },
    secrets: { categories: [...secretCategories].sort(), matches: secretMatches },
    retriesAndFailures: { retryCount, failureCount: failures.length, failures: failures.slice(0, MAX_ATTEMPTS) },
    findings: findings.sort((left, right) => left.id.localeCompare(right.id)),
    warnings: warnings.map(limitText).sort(),
    summary: { passed: false, failCount: 0, warningCount: 0 }
  };
  const failCount = reportWithoutHash.findings.filter((finding) => finding.severity === "fail").length;
  const warningCount = reportWithoutHash.findings.filter((finding) => finding.severity === "warning").length + reportWithoutHash.warnings.length;
  reportWithoutHash.summary = { passed: failCount === 0, failCount, warningCount };
  reportWithoutHash.artifact.logicalHash = hashLogicalReport(reportWithoutHash);
  return reportWithoutHash;
}

export async function loadEvidenceReport(path: string, projectRoot = process.cwd()): Promise<EvidenceReport> {
  const resolved = await resolveExistingReportPath(path, projectRoot);
  const source = await readFile(resolved, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_REPORT_BYTES) throw new EvidenceReportError(`Evidence report exceeds ${MAX_REPORT_BYTES} bytes.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new EvidenceReportError("Evidence report is not valid JSON.");
  }
  const report = normalizeEvidenceReport(parsed);
  const expectedHash = hashLogicalReport(report);
  if (report.artifact.logicalHash !== expectedHash) throw new EvidenceReportError("Evidence report logical hash does not match its contents.");
  return report;
}

export function formatEvidenceReport(report: EvidenceReport): string {
  const marker = report.summary.passed ? "PASS" : "FAIL";
  return [
    `GhostAPI evidence report: ${marker}`,
    `Run: ${escapeTerminal(report.run.id)} (${escapeTerminal(report.run.status)})`,
    `GhostAPI: ${escapeTerminal(report.ghostapi.version)}`,
    `Enforcement: ${escapeTerminal(report.enforcement.mode)}${report.enforcement.degraded ? " (degraded)" : ""}`,
    `Policy hash: ${escapeTerminal(report.policy.hash ?? "none")}`,
    `Providers: ${report.coverage.providers.length > 0 ? report.coverage.providers.map(escapeTerminal).join(", ") : "none"}`,
    `Scenarios: ${report.coverage.scenarios.length > 0 ? report.coverage.scenarios.map(escapeTerminal).join(", ") : "none"}`,
    `Allowed egress attempts: ${report.egress.allowedAttempts.length}`,
    `Blocked egress attempts: ${report.egress.blockedAttempts.length}`,
    `Production egress attempts: ${report.egress.productionAttempts}`,
    `Secret categories: ${report.secrets.categories.length > 0 ? report.secrets.categories.map(escapeTerminal).join(", ") : "none"}`,
    `Retries: ${report.retriesAndFailures.retryCount}`,
    `Failures: ${report.retriesAndFailures.failureCount}`,
    `Findings: ${report.summary.failCount} fail, ${report.summary.warningCount} warning`,
    ...report.findings.map((finding) => `  ${finding.severity.toUpperCase()} ${escapeTerminal(finding.id)}: ${escapeTerminal(finding.message)}`),
    ...report.warnings.map((warning) => `  WARNING evidence: ${escapeTerminal(warning)}`)
  ].join("\n");
}

export function compareEvidenceReports(left: EvidenceReport, right: EvidenceReport): EvidenceCompareResult {
  const differences: string[] = [];
  if (left.artifact.logicalHash !== right.artifact.logicalHash) differences.push("logicalHash differs");
  if (left.summary.passed !== right.summary.passed) differences.push("summary.passed differs");
  if (left.summary.failCount !== right.summary.failCount) differences.push("summary.failCount differs");
  if (left.egress.productionAttempts !== right.egress.productionAttempts) differences.push("egress.productionAttempts differs");
  if (left.secrets.matches !== right.secrets.matches) differences.push("secrets.matches differs");
  if (stableStringify(left.coverage) !== stableStringify(right.coverage)) differences.push("coverage differs");
  if (stableStringify(left.findings) !== stableStringify(right.findings)) differences.push("findings differ");
  return { equal: differences.length === 0, leftHash: left.artifact.logicalHash, rightHash: right.artifact.logicalHash, differences };
}

export function formatEvidenceCompare(result: EvidenceCompareResult): string {
  if (result.equal) return `Evidence reports match: ${result.leftHash}`;
  return [`Evidence reports differ:`, `Left: ${result.leftHash}`, `Right: ${result.rightHash}`, ...result.differences.map((difference) => `  - ${escapeTerminal(difference)}`)].join("\n");
}

async function writeEvidenceReport(report: EvidenceReport, projectRoot: string, outPath: string | undefined): Promise<string> {
  const target = outPath === undefined ? join(getDataPaths().reports, `${report.run.id === "unknown" ? "latest" : report.run.id}.json`) : await resolveOutputPath(outPath, projectRoot);
  await ensurePrivateDirectory(dirname(target));
  await atomicWriteJson(target, report);
  const source = await readFile(target, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_REPORT_BYTES) {
    await rm(target, { force: true });
    throw new EvidenceReportError(`Evidence report exceeds ${MAX_REPORT_BYTES} bytes.`);
  }
  await pruneReports();
  return target;
}

async function readPersistedEvents(runEvidencePath?: string): Promise<ProxyEvent[]> {
  const eventsPath = runEvidencePath === undefined
    ? getDataPaths().events
    : join(dirname(runEvidencePath), "runtime", "events.jsonl");
  const paths = [eventsPath, `${eventsPath}.1`, `${eventsPath}.2`];
  const events: ProxyEvent[] = [];
  let bytes = 0;
  for (const path of paths.reverse()) {
    let source: string;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new EvidenceReportError("Event evidence must be a regular non-symlink file.");
      source = await readFile(path, "utf8");
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    bytes += Buffer.byteLength(source, "utf8");
    if (bytes > MAX_JSONL_BYTES) throw new EvidenceReportError(`Event evidence exceeds ${MAX_JSONL_BYTES} bytes.`);
    for (const line of source.split("\n")) {
      if (line.trim() === "") continue;
      const parsed = JSON.parse(line) as ProxyEvent;
      events.push(parsed);
      if (events.length >= MAX_EVENTS_FOR_REPORT) return events;
    }
  }
  return events;
}

async function readRunEvidence(runPath: string | undefined, projectRoot: string): Promise<{ path: string; evidence: RunEvidence } | null> {
  const path = runPath ?? await findLatestRunEvidence();
  if (path === undefined) return null;
  const resolved = runPath === undefined ? path : await resolveExistingReportPath(runPath, projectRoot);
  return { path: resolved, evidence: JSON.parse(await readFile(resolved, "utf8")) as RunEvidence };
}

async function findLatestRunEvidence(): Promise<string | undefined> {
  const runsDir = join(getDataPaths().root, "runs");
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const evidencePath = join(runsDir, entry.name, "run.json");
      const info = await lstat(evidencePath).catch(() => null);
      if (info?.isFile()) candidates.push({ path: evidencePath, mtimeMs: info.mtimeMs });
    }
    return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function pruneReports(): Promise<void> {
  try {
    const entries = await readdir(getDataPaths().reports, { withFileTypes: true });
    const reports = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(getDataPaths().reports, entry.name);
      const info = await lstat(path);
      if (!info.isSymbolicLink()) reports.push({ path, mtimeMs: info.mtimeMs });
    }
    for (const report of reports.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(MAX_REPORTS_RETAINED)) await rm(report.path, { force: true });
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function resolveOutputPath(outPath: string, projectRoot: string): Promise<string> {
  const target = isAbsolute(outPath) ? resolve(outPath) : resolve(projectRoot, outPath);
  assertPathInsideAllowedRoots(projectRoot, target);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new EvidenceReportError("Evidence output parent must be a real directory, not a symlink.");
  const existing = await lstat(target).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
  if (existing?.isSymbolicLink()) throw new EvidenceReportError("Evidence output path must not be a symlink.");
  return target;
}

async function resolveExistingReportPath(path: string, projectRoot: string): Promise<string> {
  const target = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  assertPathInsideAllowedRoots(projectRoot, target);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new EvidenceReportError("Evidence path must be a regular non-symlink file.");
  return target;
}

function normalizeEvidenceReport(value: unknown): EvidenceReport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EvidenceReportError("Evidence report must be an object.");
  const report = value as EvidenceReport;
  if (report.schemaVersion !== 1) throw new EvidenceReportError("Unsupported evidence report schema version.");
  if (typeof report.artifact?.logicalHash !== "string" || !/^[a-f0-9]{64}$/.test(report.artifact.logicalHash)) throw new EvidenceReportError("Evidence report is missing a valid logical hash.");
  if (report.artifact.canonicalization !== "json-stable-sorted-keys-v1") throw new EvidenceReportError("Unsupported evidence report canonicalization.");
  if (typeof report.run?.id !== "string" || typeof report.summary?.passed !== "boolean" || !Array.isArray(report.findings)) throw new EvidenceReportError("Evidence report has an invalid schema.");
  return report;
}

function sanitizeEvent(event: ProxyEvent): ProxyEvent {
  const sanitized = sanitizeSecrets(event) as ProxyEvent;
  return { ...sanitized, provider: limitText(sanitized.provider), method: limitText(sanitized.method), path: sanitizePath(sanitized.path), request: sanitizeSecrets(sanitized.request), response: sanitizeSecrets(sanitized.response) };
}

function sanitizePath(path: string): string {
  const sanitized = sanitizeSecretString(path);
  const [pathname, query = ""] = sanitized.split("?", 2);
  if (query === "") return limitText(pathname ?? "");
  const params = query.split("&").map((part) => {
    const [key = "", value = ""] = part.split("=", 2);
    return SENSITIVE_QUERY_KEYS.has(decodeURIComponentSafe(key).toLowerCase()) ? `${key}=***` : `${key}=${sanitizeSecretString(value)}`;
  });
  return limitText(`${pathname}?${params.join("&")}`);
}

function detectScenarios(events: ProxyEvent[]): string[] {
  const scenarios = new Set<string>();
  for (const event of events) {
    collectScenarioStrings(event.request, scenarios);
    collectScenarioStrings(event.response, scenarios);
  }
  return [...scenarios].sort();
}

function collectScenarioStrings(value: unknown, scenarios: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectScenarioStrings(entry, scenarios);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() === "scenario" && typeof entry === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry)) scenarios.add(entry);
      collectScenarioStrings(entry, scenarios);
    }
  }
}

function detectSecretCategories(value: unknown): { categories: Set<string>; matches: number } {
  const categories = new Set<string>();
  let matches = 0;
  const visit = (entry: unknown, key?: string) => {
    if (key !== undefined && isSecretFieldName(key)) {
      categories.add(secretCategory(key));
      if (containsSecretPattern(entry)) matches += 1;
      return;
    }
    if (typeof entry === "string") {
      const before = categories.size;
      if (/sk_live_[A-Za-z0-9_-]+/.test(entry)) categories.add("stripe-live-key");
      if (/ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+/.test(entry)) categories.add("github-token");
      if (/Bearer\s+\S+/i.test(entry)) categories.add("bearer-token");
      if (/SG\.[A-Za-z0-9_.-]+/.test(entry)) categories.add("sendgrid-token");
      if (categories.size > before) matches += 1;
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, key);
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const [childKey, child] of Object.entries(entry as Record<string, unknown>)) visit(child, childKey);
    }
  };
  visit(value);
  return { categories, matches };
}

function containsSecretPattern(value: unknown): boolean {
  if (typeof value === "string") return /sk_live_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+|SG\.[A-Za-z0-9_.-]+/i.test(value);
  if (Array.isArray(value)) return value.some(containsSecretPattern);
  if (value !== null && typeof value === "object") return Object.values(value as Record<string, unknown>).some(containsSecretPattern);
  return false;
}

function hashLogicalReport(report: EvidenceReport): string {
  const logical = structuredClone(report) as EvidenceReport;
  logical.artifact.logicalHash = "";
  logical.artifact.generatedAt = "";
  return createHash("sha256").update(stableStringify(logical), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function firstTimestamp(events: Array<{ timestamp?: unknown }>): string | undefined {
  return events.map((event) => readString(event.timestamp)).filter((value): value is string => value !== undefined).sort()[0];
}

function lastTimestamp(events: Array<{ timestamp?: unknown }>): string | undefined {
  return events.map((event) => readString(event.timestamp)).filter((value): value is string => value !== undefined).sort().at(-1);
}

function lastExitCode(events: Array<{ exitCode?: unknown }>): number | undefined {
  return events.map((event) => event.exitCode).filter((value): value is number => Number.isInteger(value)).at(-1);
}

function hasRetryAfter(event: ProxyEvent): boolean {
  return JSON.stringify(event.response).toLowerCase().includes("retry-after") || JSON.stringify(event.request).toLowerCase().includes("retry-after");
}

function readRunStatus(value: unknown): EvidenceReport["run"]["status"] {
  return value === "preparing" || value === "running" || value === "failed-to-start" || value === "finished" ? value : "unknown";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? limitText(sanitizeSecretString(value)) : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueSorted(value.filter((entry): entry is string => typeof entry === "string").map(limitText)) : [];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map(limitText))].sort();
}

function limitText(value: string): string {
  const sanitized = sanitizeSecretString(value).replace(/[\r\n\t]/g, " ");
  return sanitized.length > 2_000 ? `${sanitized.slice(0, 2_000)}[truncated]` : sanitized;
}

function escapeTerminal(value: string): string {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function secretCategory(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized.includes("cookie")) return "cookie";
  if (normalized.includes("authorization")) return "authorization-header";
  if (normalized.includes("api")) return "api-key";
  if (normalized.includes("password")) return "password";
  if (normalized.includes("token")) return "token";
  return "secret-field";
}

function readPackageVersion(): string {
  return typeof packageJson.version === "string" ? packageJson.version : "unknown";
}

async function realProjectRoot(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new EvidenceReportError("Project root must be a real directory, not a symlink.");
  return root;
}

function assertPathInside(root: string, target: string): void {
  const relativePath = relative(root, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new EvidenceReportError("Evidence path traversal outside the project root is not allowed.");
  if (basename(target).trim() === "") throw new EvidenceReportError("Evidence path must include a file name.");
}

function assertPathInsideAllowedRoots(projectRoot: string, target: string): void {
  if (!isInside(projectRoot, target) && !isInside(getDataPaths().root, target)) throw new EvidenceReportError("Evidence path traversal outside the project root or GHOSTAPI_DATA_DIR is not allowed.");
  if (basename(target).trim() === "") throw new EvidenceReportError("Evidence path must include a file name.");
}

function isInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), target);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
