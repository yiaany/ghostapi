#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { generate } from "selfsigned";
import { createServer } from "../server/createServer.js";
import { clearCache } from "../cache/index.js";
import { clearState } from "../state/stateStore.js";
import { clearEvents } from "../server/eventsStore.js";
import { DEFAULT_MODEL, loadServerConfig, type ServerConfig } from "../config/serverConfig.js";
import { CONFIG_PATH, GHOSTAPI_DIR, initializeLocalConfig, readLocalConfig, writeLocalConfig } from "../config/localConfig.js";
import { isRegisteredProvider, providerRegistry } from "../providers/registry.js";
import { parseCliArgs, type ClearTarget, type OpenOptions } from "./parser.js";
import { CliError } from "./errors.js";
import { startMcpServer } from "../mcp/server.js";
import { generateRepoSetup, writeRepoSetup } from "../setup/setupGenerator.js";
import { generateSafetyReport } from "../report/safetyReport.js";

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
      await runDoctor(command.options.port);
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
    console.log(`GhostAPI listening on ${protocol}://${config.host}:${config.port}`);
    console.log(`Dashboard: ${dashboardUrl}`);
    console.log(`Model: ${config.model}${config.offline ? " (offline)" : ""}`);
    if (open) openUrl(dashboardUrl);
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
  console.log(result.created ? `Created ${CONFIG_PATH}.` : `${CONFIG_PATH} already exists.`);
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
  for (const adapter of Object.values(providerRegistry)) {
    console.log(`${adapter.name.padEnd(8)} ${adapter.displayName}`);
  }
}

function inspectProvider(provider: string): void {
  if (!isRegisteredProvider(provider)) {
    throw new CliError(`Unknown provider: ${provider}`, `Run ghostapi providers list to see supported providers.`);
  }
  const adapter = providerRegistry[provider];
  console.log(`${adapter.displayName}`);
  console.log(`Name: ${adapter.name}`);
  console.log(`Mode: ${adapter.name === "generic" ? "fallback" : "built-in adapter"}`);
  console.log("Error formatting: supported");
}

async function runDoctor(portOverride: number | undefined): Promise<void> {
  const config = loadServerConfig(process.env, [], portOverride ? { port: portOverride } : {});
  const checks: Array<{ label: string; ok: boolean; detail: string; hint?: string }> = [];

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ label: "Node version", ok: major >= 20, detail: process.versions.node, hint: "Install Node.js 20 or newer." });

  const writeAccess = await canWriteGhostApiDir();
  checks.push({ label: ".ghostapi write access", ok: writeAccess, detail: GHOSTAPI_DIR, hint: "Check directory permissions in the project root." });

  const portAvailable = await isPortAvailable(config.host, config.port);
  checks.push({ label: "Port availability", ok: portAvailable, detail: `${config.host}:${config.port}`, hint: `Run ghostapi start --port <free-port>.` });

  checks.push({ label: "Model config", ok: config.model.trim() !== "", detail: config.model, hint: "Run ghostapi model set <model>." });

  const hasApiKey = Boolean(config.apiKey);
  checks.push({
    label: "LLM API key",
    ok: true,
    detail: config.offline ? "offline mode" : hasApiKey ? "present" : "not required; deterministic provider mocks enabled",
    hint: hasApiKey || config.offline ? undefined : "Set GHOSTAPI_LLM_API_KEY only if you want AI-generated mocks."
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

async function canWriteGhostApiDir(): Promise<boolean> {
  try {
    await mkdir(GHOSTAPI_DIR, { recursive: true });
    await access(GHOSTAPI_DIR, constants.W_OK);
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
  ghostapi start [--host 127.0.0.1] [--port 8080] [--model gpt-4o-mini] [--offline] [--https] [--open]
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
  ghostapi init`);
}

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(`Error: ${error.message}`);
    if (error.hint) console.error(`Hint: ${error.hint}`);
    process.exit(1);
  }

  const message = error instanceof Error ? error.message : "Unknown CLI error";
  console.error(`Error: ${message}`);
  console.error("Hint: Run ghostapi doctor for environment diagnostics.");
  process.exit(1);
});
