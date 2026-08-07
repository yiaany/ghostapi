#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { generate } from "selfsigned";
import { createServer } from "../server/createServer.js";
import { clearCache } from "../cache/index.js";
import { clearState } from "../state/stateStore.js";
import { clearEvents } from "../server/eventsStore.js";
import { DEFAULT_MODEL, loadServerConfig, type ServerConfig } from "../config/serverConfig.js";
import { initializeLocalConfig, readLocalConfig, writeLocalConfig } from "../config/localConfig.js";
import { getDataPaths } from "../config/dataPaths.js";
import { detectEgressCapabilities, formatEgressCapabilityReport } from "../egress/capabilities.js";
import { EgressRunError, runEgressCommand } from "../egress/run.js";
import { PolicyValidationError, evaluatePolicy, formatPolicyDecision, loadPolicyFile } from "../policy/index.js";
import { isLoopbackHost } from "../server/accessControl.js";
import { getProviderManifests, isRegisteredProvider, providerRegistry } from "../providers/registry.js";
import { parseCliArgs, type ClearTarget, type OpenOptions } from "./parser.js";
import { CliError } from "./errors.js";
import { startMcpServer } from "../mcp/server.js";
import { generateRepoSetup, writeRepoSetup } from "../setup/setupGenerator.js";
import { generateSafetyReport } from "../report/safetyReport.js";
import { compareEvidenceReports, formatEvidenceCompare, formatEvidenceReport, generateEvidenceReport, loadEvidenceReport, EvidenceReportError } from "../evidence/index.js";
import { createScenarioReplayer, formatScenarioSanitizationSummary, loadScenarioBundle, prepareScenarioRecordingFromFile, ScenarioBundleError, writeScenarioBundle, type ScenarioPiiRules, type ScenarioReplayRequest } from "../scenarios/scenarioBundle.js";
import { ContractError, diffContracts, formatContractDiff, importHarContractFromFile, importOpenApiContractFromFile, loadContract, writeContract } from "../contracts/index.js";

async function main(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2));

  switch (command.name) {
    case "start": {
      const config = loadServerConfig(process.env, [], command.options);
      await startServer(config, command.options.open === true);
      return;
    }
    case "clear":
      await clearTarget(command.target);
      return;
    case "model-get":
      await printModel();
      return;
    case "model-set":
      await setModel(command.model);
      return;
    case "providers-list":
      listProviders();
      return;
    case "providers-inspect":
      inspectProvider(command.provider);
      return;
    case "doctor":
      await runDoctor(command.options);
      return;
    case "run": {
      const result = await runEgressCommand(command.options);
      process.exitCode = result.exitCode;
      return;
    }
    case "policy-validate":
      await validatePolicy(command.file);
      return;
    case "policy-explain":
      await explainPolicy(command.file, command.event);
      return;
    case "evidence-generate":
      await generateEvidence(command.options);
      return;
    case "evidence-view":
      await viewEvidence(command.options);
      return;
    case "evidence-compare":
      await compareEvidence(command.options);
      return;
    case "record":
      await recordScenario(command.options);
      return;
    case "replay":
      await replayBundle(command.options);
      return;
    case "contract-import-openapi":
      await importOpenApi(command.options);
      return;
    case "contract-import-har":
      await importHar(command.options);
      return;
    case "contract-diff":
      await diffContractFiles(command.options);
      return;
    case "init":
      await initProject();
      return;
    case "setup":
      await printRepoSetup(command.options.write === true);
      return;
    case "open":
      openDashboard(command.options);
      return;
    case "report":
      await printSafetyReport();
      return;
    case "mcp":
      await startMcpServer();
      return;
    case "help":
      printHelp();
      return;
  }
}

async function startServer(config: ServerConfig, open = false): Promise<void> {
  const app = await createServer(config);
  const protocol = config.https ? "https" : "http";

  const server = config.https
    ? https.createServer(await createDevTlsOptions(config.host), app)
    : http.createServer(app);

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Error: Port ${config.port} is already in use.`);
      console.error(`Hint: Run ghostapi start --port <free-port> or stop the process using ${config.port}.`);
      process.exit(1);
    }
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    const dashboardUrl = `${protocol}://${config.host}:${config.port}/dashboard`;
    const remote = !isLoopbackHost(config.host);
    console.log(`GhostAPI listening on ${protocol}://${config.host}:${config.port}`);
    console.log(`Dashboard: ${dashboardUrl}`);
    console.log(`Model: ${config.model}${config.offline ? " (offline)" : config.allowExternalLlm ? " (external LLM opt-in enabled)" : " (local only)"}`);
    if (remote) {
      console.warn("Warning: GhostAPI is bound beyond loopback. Use HTTPS or a secure tunnel because the dashboard token does not encrypt traffic.");
    }
    if (open) openUrl(remote && config.authToken ? `${dashboardUrl}?token=${encodeURIComponent(config.authToken)}` : dashboardUrl);
  });
}

async function createDevTlsOptions(host: string): Promise<https.ServerOptions> {
  const pems = await generate([{ name: "commonName", value: host }], {
    algorithm: "sha256",
    keySize: 2048,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] }
    ]
  });
  return { key: pems.private, cert: pems.cert };
}

async function clearTarget(target: ClearTarget): Promise<void> {
  if (target === "cache" || target === "all") await clearCache();
  if (target === "state" || target === "all") await clearState();
  if (target === "events" || target === "all") await clearEvents();
  console.log(`Cleared ${target}.`);
}

async function initProject(): Promise<void> {
  const result = await initializeLocalConfig();
  const configPath = getDataPaths().config;
  console.log(result.created ? `Created ${configPath}.` : `${configPath} already exists.`);
  console.log(`Model: ${result.config.model ?? DEFAULT_MODEL}`);
}

async function printRepoSetup(write: boolean): Promise<void> {
  const written = write ? await writeRepoSetup() : null;
  const setup = written?.setup ?? await generateRepoSetup();
  console.log(setup.summary);
  console.log("");
  console.log("Commands:");
  for (const command of setup.commands) console.log(`  ${command}`);
  console.log("");
  console.log("Files to copy:");
  for (const file of setup.files) console.log(`  ${file.path} - ${file.description}`);
  console.log("");
  console.log("Patches:");
  for (const patch of setup.patches) console.log(`  ${patch.title} -> ${patch.appliesTo}`);

  if (written !== null) {
    const { result } = written;
    console.log("");
    console.log(`Created: ${result.created.length > 0 ? result.created.join(", ") : "none"}`);
    console.log(`Skipped existing: ${result.skipped.length > 0 ? result.skipped.join(", ") : "none"}`);
  }
}

function openDashboard(options: OpenOptions): void {
  const protocol = options.https ? "https" : "http";
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8080;
  const url = `${protocol}://${host}:${port}/dashboard`;
  openUrl(url);
  console.log(`Opened ${url}`);
}

function openUrl(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function printSafetyReport(): Promise<void> {
  const report = await generateSafetyReport();
  console.log(`GhostAPI safety report for ${report.projectRoot}`);
  console.log(`Detected SDKs: ${report.detected.length > 0 ? report.detected.join(", ") : "none"}`);
  console.log("");
  if (report.findings.length === 0) {
    console.log("No high-risk provider usage found.");
  } else {
    console.log("Findings:");
    for (const finding of report.findings) {
      console.log(`  ${finding.severity.toUpperCase()} ${finding.file ? `${finding.file}: ` : ""}${finding.message}`);
    }
  }
  console.log("");
  console.log("Recommendations:");
  for (const recommendation of report.recommendations) console.log(`  - ${recommendation}`);
}

async function printModel(): Promise<void> {
  const config = await readLocalConfig();
  console.log(config.model ?? process.env.GHOSTAPI_MODEL ?? DEFAULT_MODEL);
}

async function setModel(model: string): Promise<void> {
  const config = await readLocalConfig();
  await writeLocalConfig({ ...config, model });
  console.log(`Model set to ${model}.`);
}

function listProviders(): void {
  for (const manifest of getProviderManifests()) {
    const version = manifest.packVersion === null ? manifest.implementation : `pack ${manifest.packVersion}`;
    console.log(`${manifest.name.padEnd(8)} ${manifest.displayName} (${version})`);
  }
}

function inspectProvider(provider: string): void {
  if (!isRegisteredProvider(provider)) {
    throw new CliError(`Unknown provider: ${provider}`, `Run ghostapi providers list to see supported providers.`);
  }
  const adapter = providerRegistry[provider];
  const manifest = getProviderManifests().find((candidate) => candidate.name === provider);
  if (manifest === undefined) throw new CliError(`Provider manifest missing: ${provider}`);
  console.log(`${adapter.displayName}`);
  console.log(`Name: ${adapter.name}`);
  console.log(`Mode: ${manifest.implementation}`);
  console.log(`Pack version: ${manifest.packVersion ?? "n/a"}`);
  console.log(`API versions: ${manifest.apiVersions?.supported.join(", ") ?? "legacy"}`);
  console.log(`Capabilities: ${Object.entries(manifest.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(", ")}`);
  console.log("Error formatting: supported");
}

async function runDoctor(options: { port?: number; egress?: boolean; json?: boolean }): Promise<void> {
  if (options.egress) {
    const report = detectEgressCapabilities();
    console.log(options.json ? JSON.stringify(report, null, 2) : formatEgressCapabilityReport(report));
    return;
  }

  const config = loadServerConfig(process.env, [], options.port ? { port: options.port } : {});
  const checks: Array<{ label: string; ok: boolean; detail: string; hint?: string }> = [];

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ label: "Node version", ok: major >= 20, detail: process.versions.node, hint: "Install Node.js 20 or newer." });

  const writeAccess = await canWriteGhostApiDir();
  checks.push({ label: "GhostAPI data write access", ok: writeAccess, detail: getDataPaths().root, hint: "Check GHOSTAPI_DATA_DIR and directory permissions." });

  const portAvailable = await isPortAvailable(config.host, config.port);
  checks.push({ label: "Port availability", ok: portAvailable, detail: `${config.host}:${config.port}`, hint: `Run ghostapi start --port <free-port>.` });

  checks.push({ label: "Model config", ok: config.model.trim() !== "", detail: config.model, hint: "Run ghostapi model set <model>." });

  const hasApiKey = Boolean(config.apiKey);
  checks.push({
    label: "LLM API key",
    ok: true,
    detail: config.offline ? "offline mode" : config.allowExternalLlm ? hasApiKey ? "explicitly enabled" : "enabled without GHOSTAPI_LLM_API_KEY" : "disabled; deterministic provider mocks enabled",
    hint: config.allowExternalLlm && !hasApiKey ? "Set GHOSTAPI_LLM_API_KEY or remove the external LLM opt-in." : undefined
  });

  const tlsBypass = process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0";
  checks.push({ label: "TLS safety", ok: !tlsBypass, detail: tlsBypass ? "NODE_TLS_REJECT_UNAUTHORIZED=0" : "safe", hint: "Unset NODE_TLS_REJECT_UNAUTHORIZED." });

  let failed = 0;
  for (const check of checks) {
    const marker = check.ok ? "ok" : "fail";
    console.log(`${marker.padEnd(4)} ${check.label}: ${check.detail}`);
    if (!check.ok) {
      failed += 1;
      if (check.hint) console.log(`     Hint: ${check.hint}`);
    }
  }

  if (failed > 0) throw new CliError(`Doctor found ${failed} issue${failed === 1 ? "" : "s"}.`);
}

async function validatePolicy(file: string | undefined): Promise<void> {
  const loaded = await loadPolicyFile(file, process.cwd(), true);
  if (loaded === null) throw new CliError("Policy file was not found.");
  console.log(`Policy valid: ${loaded.path}`);
  console.log(`Schema version: ${loaded.policy.version}`);
  console.log(`SHA-256: ${loaded.hash}`);
}

async function explainPolicy(file: string | undefined, event: Parameters<typeof evaluatePolicy>[1]): Promise<void> {
  const loaded = await loadPolicyFile(file, process.cwd(), true);
  if (loaded === null) throw new CliError("Policy file was not found.");
  console.log(formatPolicyDecision(evaluatePolicy(loaded.policy, event)));
}

async function generateEvidence(options: { policyPath?: string; runPath?: string; outPath?: string; contractBaselinePath?: string; contractCandidatePath?: string; ci?: boolean; json?: boolean }): Promise<void> {
  const { report, path } = await generateEvidenceReport({ policyPath: options.policyPath, runPath: options.runPath, outPath: options.outPath, contractBaselinePath: options.contractBaselinePath, contractCandidatePath: options.contractCandidatePath });
  if (options.json) console.log(JSON.stringify({ path, report }, null, 2));
  else {
    console.log(formatEvidenceReport(report));
    console.log(`Artifact: ${path}`);
  }
  if (options.ci && !report.summary.passed) process.exitCode = 2;
}

async function viewEvidence(options: { path: string; json?: boolean }): Promise<void> {
  const report = await loadEvidenceReport(options.path);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatEvidenceReport(report));
}

async function compareEvidence(options: { leftPath: string; rightPath: string; json?: boolean }): Promise<void> {
  const left = await loadEvidenceReport(options.leftPath);
  const right = await loadEvidenceReport(options.rightPath);
  const result = compareEvidenceReports(left, right);
  console.log(options.json ? JSON.stringify(result, null, 2) : formatEvidenceCompare(result));
  if (!result.equal) process.exitCode = 1;
}

async function recordScenario(options: { inputPath: string; outPath?: string; title?: string; allowedSandboxHosts: string[]; pii?: string; approve?: boolean }): Promise<void> {
  const bundle = await prepareScenarioRecordingFromFile(options.inputPath, {
    title: options.title,
    allowedSandboxHosts: options.allowedSandboxHosts,
    pii: parsePiiRules(options.pii)
  });
  console.log(formatScenarioSanitizationSummary(bundle.sanitization));
  if (bundle.sanitization.requiresApproval && !options.approve) {
    throw new CliError("Recording was not saved because sanitization found potentially sensitive traffic.", "Review the summary, then re-run the exact command with --approve to save the sanitized bundle.");
  }
  const path = await writeScenarioBundle(bundle, options.outPath);
  console.log(`Bundle: ${path}`);
}

async function replayBundle(options: { bundlePath: string; requestsPath: string; json?: boolean }): Promise<void> {
  const bundle = await loadScenarioBundle(options.bundlePath);
  const requests = await loadReplayRequests(options.requestsPath);
  const replayer = createScenarioReplayer(bundle);
  const responses = requests.map((request) => replayer.replay(request));
  if (replayer.remaining !== 0) throw new CliError(`Replay ended with ${replayer.remaining} interaction${replayer.remaining === 1 ? "" : "s"} remaining.`, "Provide the complete ordered request sequence; GhostAPI never guesses a later match.");
  if (options.json) console.log(JSON.stringify({ responses }, null, 2));
  else {
    console.log(`Replay matched ${responses.length} interaction${responses.length === 1 ? "" : "s"}.`);
    for (const response of responses) console.log(`  ${response.index}: ${response.status}`);
  }
}

async function importOpenApi(options: { inputPath: string; outPath?: string; title?: string }): Promise<void> {
  const contract = await importOpenApiContractFromFile(options.inputPath, { title: options.title });
  const path = await writeContract(contract, options.outPath);
  console.log(`Contract: ${path}`);
  console.log(`Operations: ${contract.operations.length}`);
}

async function importHar(options: { inputPath: string; outPath?: string; contractOutPath?: string; title?: string; allowedSandboxHosts: string[]; pii?: string; approve?: boolean }): Promise<void> {
  const { bundle, contract } = await importHarContractFromFile(options.inputPath, {
    title: options.title,
    allowedSandboxHosts: options.allowedSandboxHosts,
    pii: parsePiiRules(options.pii)
  });
  console.log(formatScenarioSanitizationSummary(bundle.sanitization));
  if (bundle.sanitization.requiresApproval && !options.approve) {
    throw new CliError("HAR import was not saved because sanitization found potentially sensitive traffic.", "Review the summary, then re-run the exact command with --approve to save the sanitized bundle and contract.");
  }
  const bundlePath = await writeScenarioBundle(bundle, options.outPath);
  const contractPath = await writeContract(contract, options.contractOutPath);
  console.log(`Bundle: ${bundlePath}`);
  console.log(`Contract: ${contractPath}`);
}

async function diffContractFiles(options: { baselinePath: string; candidatePath: string; policyPath?: string; ci?: boolean; json?: boolean }): Promise<void> {
  const [baseline, candidate, loadedPolicy] = await Promise.all([
    loadContract(options.baselinePath),
    loadContract(options.candidatePath),
    options.policyPath === undefined ? Promise.resolve(null) : loadPolicyFile(options.policyPath, process.cwd(), true)
  ]);
  const diff = diffContracts(baseline, candidate);
  const decision = loadedPolicy === null ? null : evaluatePolicy(loadedPolicy.policy, { type: "report", productionEgressAttempts: 0, forbiddenCredentialMatches: 0, breakingContractChanges: diff.summary.breaking });
  if (options.json) console.log(JSON.stringify({ diff, policy: decision }, null, 2));
  else {
    console.log(formatContractDiff(diff));
    if (decision !== null) console.log(`Policy: ${decision.allowed ? "PASS" : "FAIL"} - ${decision.reason}`);
  }
  if (options.ci && (decision === null ? diff.summary.breaking > 0 : !decision.allowed)) process.exitCode = 2;
}

function parsePiiRules(value: string | undefined): Partial<ScenarioPiiRules> | undefined {
  if (value === undefined) return undefined;
  const selected = new Set(value === "none" ? [] : value.split(","));
  return { emails: selected.has("emails"), phones: selected.has("phones"), addresses: selected.has("addresses") };
}

async function loadReplayRequests(path: string): Promise<ScenarioReplayRequest[]> {
  const target = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
  if (!isInsideAllowedRoots(target)) throw new CliError("Replay requests path traversal outside the project root or GHOSTAPI_DATA_DIR is not allowed.");
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new CliError("Replay requests input must be a regular non-symlink file.");
  if (!await isRealPathInsideAllowedRoots(target)) throw new CliError("Replay requests input resolves outside the project root or GHOSTAPI_DATA_DIR through a symlink.");
  const source = await readFile(target, "utf8");
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024) throw new CliError("Replay requests input exceeds 1048576 bytes.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new CliError("Replay requests input is not valid JSON.");
  }
  const requests = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { requests?: unknown }).requests) ? (parsed as { requests: unknown[] }).requests : null;
  if (requests === null || requests.length === 0 || requests.length > 100) throw new CliError("Replay requests input must contain 1-100 requests.");
  return requests.map((request) => {
    if (request === null || typeof request !== "object" || Array.isArray(request)) throw new CliError("Replay request must be an object.");
    const candidate = request as Record<string, unknown>;
    if (typeof candidate.method !== "string" || typeof candidate.path !== "string") throw new CliError("Replay request requires string method and path.");
    return { method: candidate.method, path: candidate.path, headers: candidate.headers as ScenarioReplayRequest["headers"], body: candidate.body };
  });
}

function isInsideAllowedRoots(target: string): boolean {
  return isInside(process.cwd(), target) || isInside(getDataPaths().root, target);
}

function isInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), target);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

async function isRealPathInsideAllowedRoots(target: string): Promise<boolean> {
  const realTarget = await realpath(target);
  const realProjectRoot = await realpath(process.cwd());
  const dataRoot = await realpath(getDataPaths().root).catch(() => null);
  return isInside(realProjectRoot, realTarget) || (dataRoot !== null && isInside(dataRoot, realTarget));
}

async function canWriteGhostApiDir(): Promise<boolean> {
  const dataDir = getDataPaths().root;
  try {
    await mkdir(dataDir, { recursive: true });
    await access(dataDir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

function printHelp(): void {
  console.log(`GhostAPI CLI

Usage:
  ghostapi start [--host 127.0.0.1] [--port 8080] [--model gpt-4o-mini] [--offline] [--https] [--allow-external-llm] [--open]
  ghostapi open [--host 127.0.0.1] [--port 8080] [--https]
  ghostapi clear cache|state|events|all
  ghostapi model get
  ghostapi model set <model>
  ghostapi providers list
  ghostapi providers inspect <provider>
  ghostapi setup [--write]
  ghostapi report
  ghostapi mcp
  ghostapi doctor [--port 8080]
  ghostapi doctor --egress [--json]
  ghostapi run [--port 8080] [--allow-host localhost] [--policy ghostapi.policy.yaml] -- <command> [args...]
  ghostapi policy validate [--file ghostapi.policy.yaml]
  ghostapi policy explain <scenario-id>|network <host>|credential <value>|enforcement <mode>|report <production-attempts> <credential-matches> [--file ghostapi.policy.yaml]
  ghostapi evidence generate [--policy ghostapi.policy.yaml] [--run .ghostapi/runs/<id>/run.json] [--out .ghostapi/reports/report.json] [--contract-baseline base.contract.json --contract-candidate head.contract.json] [--ci] [--json]
  ghostapi evidence view <report.json> [--json]
  ghostapi evidence compare <left.json> <right.json> [--json]
  ghostapi record --input <capture.json|har.json> --allow-sandbox-host <host> [--out bundle.json] [--title title] [--pii emails,phones,addresses] [--approve]
  ghostapi replay <bundle.json> --requests <requests.json> [--json]
  ghostapi contract import-openapi --input <openapi.json> [--out contract.json] [--title title]
  ghostapi contract import-har --input <capture.har> --allow-sandbox-host <host> [--out bundle.json] [--contract-out contract.json] [--title title] [--pii emails,phones,addresses] [--approve]
  ghostapi contract diff --baseline <contract.json> --candidate <contract.json> [--policy ghostapi.policy.yaml] [--ci] [--json]
  ghostapi init`);
}

main().catch((error: unknown) => {
  if (error instanceof CliError || error instanceof EgressRunError) {
    console.error(`Error: ${error.message}`);
    if (error.hint) console.error(`Hint: ${error.hint}`);
    process.exit(1);
  }

  if (error instanceof PolicyValidationError) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  if (error instanceof EvidenceReportError) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  if (error instanceof ScenarioBundleError) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  if (error instanceof ContractError) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  const message = error instanceof Error ? error.message : "Unknown CLI error";
  console.error(`Error: ${message}`);
  console.error("Hint: Run ghostapi doctor for environment diagnostics.");
  process.exit(1);
});
