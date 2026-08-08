import http from "node:http";
import { spawn } from "node:child_process";
import { createServer } from "../server/createServer.js";
import { sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson } from "../storage/fileStore.js";

type BootstrapConfig = {
  runId: string;
  port: number;
  runDirectory: string;
  runtimeDataDir: string;
  evidencePath: string;
  allowedHosts: string[];
  command: string[];
};

type RunEvidence = {
  schemaVersion: 1;
  runId: string;
  backend: "linux-network-namespace";
  status: "preparing" | "running" | "failed-to-start" | "finished";
  command: { executable: string; argumentCount: number };
  policy: { default: "deny"; allowedHosts: string[]; ghostApiOrigin: string; policyHash?: string; requiredScenarios: string[] };
  networkAttemptAttribution: string;
  events: Array<{ type: string; timestamp: string; detail?: string; exitCode?: number }>;
};

async function main(): Promise<void> {
  const config = parseConfig();
  await runIp(["link", "set", "lo", "up"]);

  process.env.GHOSTAPI_DATA_DIR = config.runtimeDataDir;
  process.env.GHOSTAPI_OFFLINE = "true";
  delete process.env.GHOSTAPI_ALLOW_EXTERNAL_LLM;
  delete process.env.GHOSTAPI_LLM_API_KEY;

  const evidence = await readEvidence(config.evidencePath);
  evidence.status = "running";
  evidence.events.push({ type: "loopback-enabled", timestamp: new Date().toISOString() });

  const app = await createServer({ host: "127.0.0.1", port: config.port, model: process.env.GHOSTAPI_MODEL ?? "gpt-4o-mini", offline: true });
  const server = http.createServer(app);
  await listen(server, config.port);
  evidence.events.push({ type: "ghostapi-ready", timestamp: new Date().toISOString(), detail: `http://127.0.0.1:${config.port}` });
  await atomicWriteJson(config.evidencePath, evidence);

  const targetEnvironment = createTargetEnvironment(process.env);
  delete targetEnvironment.GHOSTAPI_RUN_BOOTSTRAP_CONFIG;
  delete targetEnvironment.GHOSTAPI_LLM_API_KEY;
  delete targetEnvironment.GHOSTAPI_AUTH_TOKEN;
  targetEnvironment.GHOSTAPI_RUN_ID = config.runId;
  targetEnvironment.GHOSTAPI_BASE_URL = `http://127.0.0.1:${config.port}`;
  targetEnvironment.GHOSTAPI_HOST = "127.0.0.1";
  targetEnvironment.GHOSTAPI_PORT = String(config.port);
  targetEnvironment.GHOSTAPI_PROTOCOL = "http";
  targetEnvironment.GHOSTAPI_OPENAI_BASE_URL = `http://127.0.0.1:${config.port}/v1`;

  let result: { exitCode: number; signal: string | null } | undefined;
  let interruptedBy: NodeJS.Signals | undefined;
  try {
    const target = spawn(config.command[0]!, config.command.slice(1), { env: targetEnvironment, stdio: "inherit", detached: true });
    const forward = (signal: NodeJS.Signals) => {
      interruptedBy = signal;
      if (target.pid !== undefined) process.kill(-target.pid, signal);
    };
    process.once("SIGINT", () => forward("SIGINT"));
    process.once("SIGTERM", () => forward("SIGTERM"));
    process.once("SIGHUP", () => forward("SIGHUP"));
    result = await waitForTarget(target);
    process.exitCode = result.exitCode;
  } catch (error) {
    evidence.status = "failed-to-start";
    evidence.events.push({ type: "target-failed-to-start", timestamp: new Date().toISOString(), detail: error instanceof Error ? error.message : "Unknown target error" });
    process.exitCode = 1;
  } finally {
    if (result !== undefined) {
      evidence.status = "finished";
      evidence.events.push({ type: "target-exited", timestamp: new Date().toISOString(), exitCode: result.exitCode, detail: interruptedBy ?? result.signal ?? undefined });
    }
    await atomicWriteJson(config.evidencePath, evidence);
    await close(server);
  }
}

function createTargetEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const targetEnvironment = { ...environment };
  for (const [key, value] of Object.entries(targetEnvironment)) {
    if (isSensitiveEnvironmentKey(key) || (value !== undefined && sanitizeSecretString(value) !== value)) delete targetEnvironment[key];
  }
  return targetEnvironment;
}

function isSensitiveEnvironmentKey(key: string): boolean {
  return /(?:api[_-]?key|token|secret|password|credential|authorization|cookie)/i.test(key);
}

function parseConfig(): BootstrapConfig {
  const raw = process.env.GHOSTAPI_RUN_BOOTSTRAP_CONFIG;
  if (!raw) throw new Error("Missing GhostAPI run bootstrap configuration.");
  const parsed = JSON.parse(raw) as Partial<BootstrapConfig>;
  if (!Array.isArray(parsed.command) || parsed.command.length === 0 || typeof parsed.port !== "number" || typeof parsed.evidencePath !== "string" || typeof parsed.runtimeDataDir !== "string" || typeof parsed.runId !== "string" || !Array.isArray(parsed.allowedHosts)) {
    throw new Error("Invalid GhostAPI run bootstrap configuration.");
  }
  return parsed as BootstrapConfig;
}

async function readEvidence(path: string): Promise<RunEvidence> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as RunEvidence;
}

function runIp(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ip", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Unable to configure loopback: ${stderr || `ip exited ${code}`}`)));
  });
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function waitForTarget(target: ReturnType<typeof spawn>): Promise<{ exitCode: number; signal: string | null }> {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.once("exit", (code, signal) => resolve({ exitCode: code ?? 128 + 1, signal }));
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown bootstrap error";
  console.error(`GhostAPI run setup failed: ${message}`);
  process.exitCode = 1;
});
