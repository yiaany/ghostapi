import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { getDataDir } from "../config/dataPaths.js";
import { sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson } from "../storage/fileStore.js";

export type EgressRunOptions = {
  port?: number;
  allowHosts: string[];
  command: string[];
};

export type EgressRunResult = {
  exitCode: number;
  runId: string;
  evidencePath: string;
};

type RunEvidence = {
  schemaVersion: 1;
  runId: string;
  backend: "linux-network-namespace";
  status: "preparing" | "running" | "failed-to-start" | "finished";
  command: { executable: string; argumentCount: number };
  policy: { default: "deny"; allowedHosts: string[]; ghostApiOrigin: string };
  networkAttemptAttribution: "allowed GhostAPI requests appear in the GhostAPI event log; denied kernel socket attempts are not attributable by this backend";
  events: Array<{ type: string; timestamp: string; detail?: string; exitCode?: number }>;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export class EgressRunError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = "EgressRunError";
    this.hint = hint;
  }
}

export async function runEgressCommand(options: EgressRunOptions): Promise<EgressRunResult> {
  validateOptions(options);
  if (process.platform !== "linux") {
    throw new EgressRunError(
      `ghostapi run enforcement is unavailable on ${process.platform}.`,
      "Use a Linux host with unshare-enabled user and network namespaces. Proxy guidance is not an enforcement fallback."
    );
  }

  const runId = randomUUID();
  const port = options.port ?? 8080;
  const runDirectory = join(getDataDir(), "runs", runId);
  const evidencePath = join(runDirectory, "run.json");
  const runtimeDataDir = join(runDirectory, "runtime");
  const allowedHosts = uniqueHosts(["127.0.0.1", "localhost", ...options.allowHosts]);
  const evidence: RunEvidence = {
    schemaVersion: 1,
    runId,
    backend: "linux-network-namespace",
    status: "preparing",
    command: { executable: sanitizeSecretString(basename(options.command[0]!)), argumentCount: options.command.length - 1 },
    policy: { default: "deny", allowedHosts, ghostApiOrigin: `http://127.0.0.1:${port}` },
    networkAttemptAttribution: "allowed GhostAPI requests appear in the GhostAPI event log; denied kernel socket attempts are not attributable by this backend",
    events: [{ type: "run-created", timestamp: new Date().toISOString() }]
  };

  await mkdir(runtimeDataDir, { recursive: true, mode: 0o700 });
  await atomicWriteJson(evidencePath, evidence);

  try {
    await preflightLinuxNamespaces();
    evidence.events.push({ type: "namespace-preflight-passed", timestamp: new Date().toISOString() });
    await atomicWriteJson(evidencePath, evidence);
    const exitCode = await launchLinuxNamespace(options.command, { runId, port, runDirectory, runtimeDataDir, evidencePath, allowedHosts });
    return { exitCode, runId, evidencePath };
  } catch (error) {
    evidence.status = "failed-to-start";
    evidence.events.push({ type: "run-failed-to-start", timestamp: new Date().toISOString(), detail: safeErrorMessage(error) });
    await atomicWriteJson(evidencePath, evidence);
    throw error;
  }
}

function validateOptions(options: EgressRunOptions): void {
  if (options.command.length === 0 || options.command[0] === undefined || options.command[0].trim() === "") {
    throw new EgressRunError("ghostapi run requires a command.", "Use: ghostapi run -- <command> [args...]");
  }

  for (const host of options.allowHosts) {
    if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
      throw new EgressRunError(
        `The Linux namespace backend cannot allow external host ${host}.`,
        "This backend deliberately has no routed external egress. Use only localhost, 127.0.0.1, or ::1; do not rely on proxy fallback."
      );
    }
  }
}

async function preflightLinuxNamespaces(): Promise<void> {
  const tools = [
    { executable: "unshare", args: ["--version"] },
    { executable: "ip", args: ["link", "show", "lo"] },
    { executable: "unshare", args: ["--user", "--map-root-user", "--net", "--mount", "--pid", "--fork", "--kill-child=SIGTERM", "--mount-proc", "--propagation", "private", "--", "true"] }
  ];

  for (const tool of tools) {
    const result = await runProcess(tool.executable, tool.args);
    if (result.exitCode !== 0) {
      throw new EgressRunError(
        "Linux user, mount, and network namespace preflight failed; target command was not started.",
        `Install util-linux/iproute2 and allow unprivileged namespaces on this host. Detail: ${result.stderr || result.stdout || "command failed"}`
      );
    }
  }
}

function launchLinuxNamespace(command: string[], config: {
  runId: string;
  port: number;
  runDirectory: string;
  runtimeDataDir: string;
  evidencePath: string;
  allowedHosts: string[];
}): Promise<number> {
  const compiledBootstrapPath = fileURLToPath(new URL("./linuxBootstrap.js", import.meta.url));
  const sourceBootstrapPath = fileURLToPath(new URL("./linuxBootstrap.ts", import.meta.url));
  const bootstrapArgs = existsSync(compiledBootstrapPath)
    ? [compiledBootstrapPath]
    : ["--import", "tsx", sourceBootstrapPath];
  const bootstrapConfig = JSON.stringify({ ...config, command });
  const child = spawn("unshare", [
    "--user",
    "--map-root-user",
    "--net",
    "--mount",
    "--pid",
    "--fork",
    "--kill-child=SIGTERM",
    "--mount-proc",
    "--propagation",
    "private",
    "--",
    process.execPath,
    ...bootstrapArgs
  ], {
    env: { ...process.env, GHOSTAPI_RUN_BOOTSTRAP_CONFIG: bootstrapConfig },
    stdio: "inherit"
  });

  return new Promise((resolve, reject) => {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of signals) {
      const handler = () => child.kill(signal);
      handlers.set(signal, handler);
      process.once(signal, handler);
    }

    const cleanup = () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    };

    child.once("error", (error) => {
      cleanup();
      reject(new EgressRunError(`Failed to start Linux namespace backend: ${error.message}`, "Verify that unshare is installed and executable."));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(code ?? signalExitCode(signal));
    });
  });
}

function runProcess(executable: string, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => resolve({ exitCode: -1, stdout, stderr: error.message }));
    child.once("exit", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function uniqueHosts(hosts: string[]): string[] {
  return [...new Set(hosts.map((host) => host.toLowerCase()))];
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? sanitizeSecretString(error.message).replace(/(?:Bearer\s+)?\S*(?:token|secret|key)\S*/gi, "***") : "Unknown error";
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const signals: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGBREAK: 21, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31 };
  return 128 + (signals[signal] ?? 1);
}
