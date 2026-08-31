import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { getDataDir } from "../config/dataPaths.js";
import { sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson } from "../storage/fileStore.js";
import {
  evaluatePolicy,
  formatPolicyDecision,
  loadPolicyFile,
  type GhostApiPolicy,
} from "../policy/index.js";

export type EgressRunOptions = {
  port?: number;
  allowHosts: string[];
  policyPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
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
  policy: {
    default: "deny";
    allowedHosts: string[];
    ghostApiOrigin: string;
    policyHash?: string;
    requiredScenarios: string[];
  };
  output?: {
    bytesObserved: number;
    secretMatches: number;
    limitExceeded: boolean;
    timedOut: boolean;
  };
  networkAttemptAttribution: "allowed GhostAPI requests appear in the GhostAPI event log; denied kernel socket attempts are not attributable by this backend";
  events: Array<{
    type: string;
    timestamp: string;
    detail?: string;
    exitCode?: number;
  }>;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const STREAM_SECRET_PREFIXES = [
  "sk_live_",
  "sk_test_",
  "rk_live_",
  "ghp_",
  "github_pat_",
  "xoxb-",
  "sg.",
];

export class EgressRunError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = "EgressRunError";
    this.hint = hint;
  }
}

export async function runEgressCommand(
  options: EgressRunOptions,
): Promise<EgressRunResult> {
  const loadedPolicy = await loadPolicyFile(
    options.policyPath,
    process.cwd(),
    options.policyPath !== undefined,
  );
  validateOptions(options, loadedPolicy?.policy);
  if (process.platform !== "linux") {
    throw new EgressRunError(
      `ghostapi run enforcement is unavailable on ${process.platform}.`,
      "Use a Linux host with unshare-enabled user and network namespaces. Proxy guidance is not an enforcement fallback.",
    );
  }

  const runId = randomUUID();
  const port = options.port ?? 8080;
  const runDirectory = join(getDataDir(), "runs", runId);
  const evidencePath = join(runDirectory, "run.json");
  const runtimeDataDir = join(runDirectory, "runtime");
  const allowedHosts = uniqueHosts([
    "127.0.0.1",
    "localhost",
    ...options.allowHosts,
  ]);
  const evidence: RunEvidence = {
    schemaVersion: 1,
    runId,
    backend: "linux-network-namespace",
    status: "preparing",
    command: {
      executable: sanitizeSecretString(basename(options.command[0]!)),
      argumentCount: options.command.length - 1,
    },
    policy: {
      default: "deny",
      allowedHosts,
      ghostApiOrigin: `http://127.0.0.1:${port}`,
      policyHash: loadedPolicy?.hash,
      requiredScenarios: loadedPolicy?.policy.requiredScenarios ?? [],
    },
    networkAttemptAttribution:
      "allowed GhostAPI requests appear in the GhostAPI event log; denied kernel socket attempts are not attributable by this backend",
    events: [{ type: "run-created", timestamp: new Date().toISOString() }],
  };

  await mkdir(runtimeDataDir, { recursive: true, mode: 0o700 });
  await atomicWriteJson(evidencePath, evidence);

  try {
    await preflightLinuxNamespaces();
    evidence.events.push({
      type: "namespace-preflight-passed",
      timestamp: new Date().toISOString(),
    });
    await atomicWriteJson(evidencePath, evidence);
    const result = await launchLinuxNamespace(options.command, {
      runId,
      port,
      runDirectory,
      runtimeDataDir,
      evidencePath,
      allowedHosts,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
    const finishedEvidence = JSON.parse(
      await readFile(evidencePath, "utf8"),
    ) as RunEvidence;
    finishedEvidence.output = {
      bytesObserved: result.outputBytes,
      secretMatches: result.outputSecretMatches,
      limitExceeded: result.outputLimitExceeded,
      timedOut: result.timedOut,
    };
    if (result.timedOut)
      finishedEvidence.events.push({
        type: "run-timeout",
        timestamp: new Date().toISOString(),
      });
    if (result.outputLimitExceeded)
      finishedEvidence.events.push({
        type: "run-output-limit-exceeded",
        timestamp: new Date().toISOString(),
      });
    if (result.interruptedBy !== undefined) {
      finishedEvidence.events.push({
        type: "run-interrupted",
        timestamp: new Date().toISOString(),
        detail: result.interruptedBy,
        exitCode: signalExitCode(result.interruptedBy),
      });
      if (
        finishedEvidence.status === "preparing" ||
        finishedEvidence.status === "running"
      )
        finishedEvidence.status = "finished";
    }
    await atomicWriteJson(evidencePath, finishedEvidence);
    return {
      exitCode:
        result.interruptedBy === undefined
          ? result.exitCode
          : signalExitCode(result.interruptedBy),
      runId,
      evidencePath,
    };
  } catch (error) {
    evidence.status = "failed-to-start";
    evidence.events.push({
      type: "run-failed-to-start",
      timestamp: new Date().toISOString(),
      detail: safeErrorMessage(error),
    });
    await atomicWriteJson(evidencePath, evidence);
    throw error;
  }
}

function validateOptions(
  options: EgressRunOptions,
  policy: GhostApiPolicy | undefined,
): void {
  if (
    options.command.length === 0 ||
    options.command[0] === undefined ||
    options.command[0].trim() === ""
  ) {
    throw new EgressRunError(
      "ghostapi run requires a command.",
      "Use: ghostapi run -- <command> [args...]",
    );
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 300_000)
  ) {
    throw new EgressRunError(
      "Run timeout must be an integer between 100 and 300000 ms.",
      "Set timeoutMs only through a validated eval spec or public API call.",
    );
  }
  if (
    options.maxOutputBytes !== undefined &&
    (!Number.isInteger(options.maxOutputBytes) ||
      options.maxOutputBytes < 0 ||
      options.maxOutputBytes > 10 * 1024 * 1024)
  ) {
    throw new EgressRunError(
      "Run output limit must be an integer between 0 and 10485760 bytes.",
      "Set maxOutputBytes only through a validated eval spec or public API call.",
    );
  }

  for (const host of options.allowHosts) {
    if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
      throw new EgressRunError(
        `The Linux namespace backend cannot allow external host ${host}.`,
        "This backend deliberately has no routed external egress. Use only localhost, 127.0.0.1, or ::1; do not rely on proxy fallback.",
      );
    }
  }

  if (policy === undefined) return;
  assertPolicyAllows(policy, {
    type: "enforcement",
    mode: "linux-network-namespace",
  });
  for (const host of ["127.0.0.1", "localhost", ...options.allowHosts]) {
    assertPolicyAllows(policy, { type: "network", host, provider: "ghostapi" });
  }
  for (const value of options.command)
    assertPolicyAllows(policy, { type: "credential", value });
}

function assertPolicyAllows(
  policy: GhostApiPolicy,
  event: Parameters<typeof evaluatePolicy>[1],
): void {
  const decision = evaluatePolicy(policy, event);
  if (!decision.allowed) {
    throw new EgressRunError(
      `Policy denied ${event.type} before launching the target.`,
      formatPolicyDecision(decision),
    );
  }
}

async function preflightLinuxNamespaces(): Promise<void> {
  const tools = [
    { executable: "unshare", args: ["--version"] },
    { executable: "ip", args: ["link", "show", "lo"] },
    {
      executable: "unshare",
      args: [
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
        "true",
      ],
    },
  ];

  for (const tool of tools) {
    const result = await runProcess(tool.executable, tool.args);
    if (result.exitCode !== 0) {
      throw new EgressRunError(
        "Linux user, mount, and network namespace preflight failed; target command was not started.",
        `Install util-linux/iproute2 and allow unprivileged namespaces on this host. Detail: ${result.stderr || result.stdout || "command failed"}`,
      );
    }
  }
}

function launchLinuxNamespace(
  command: string[],
  config: {
    runId: string;
    port: number;
    runDirectory: string;
    runtimeDataDir: string;
    evidencePath: string;
    allowedHosts: string[];
    timeoutMs?: number;
    maxOutputBytes?: number;
  },
): Promise<{
  exitCode: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  outputBytes: number;
  outputSecretMatches: number;
  interruptedBy?: NodeJS.Signals;
}> {
  const compiledBootstrapPath = fileURLToPath(
    new URL("./linuxBootstrap.js", import.meta.url),
  );
  const sourceBootstrapPath = fileURLToPath(
    new URL("./linuxBootstrap.ts", import.meta.url),
  );
  const bootstrapArgs = existsSync(compiledBootstrapPath)
    ? [compiledBootstrapPath]
    : ["--import", "tsx", sourceBootstrapPath];
  const bootstrapConfig = JSON.stringify({ ...config, command });
  const child = spawn(
    "unshare",
    [
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
      ...bootstrapArgs,
    ],
    {
      env: { ...process.env, GHOSTAPI_RUN_BOOTSTRAP_CONFIG: bootstrapConfig },
      // Forward target output only after streaming redaction; evidence never stores output text.
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  return new Promise((resolve, reject) => {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map<NodeJS.Signals, () => void>();
    let timedOut = false;
    let outputLimitExceeded = false;
    let interruptedBy: NodeJS.Signals | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const terminate = (
      reason: "timeout" | "output" | "interrupt",
      signal: NodeJS.Signals = "SIGTERM",
    ) => {
      if (reason === "timeout") timedOut = true;
      if (reason === "output") outputLimitExceeded = true;
      if (reason === "interrupt") interruptedBy = signal;
      signalNamespaceProcessGroup(child, signal);
      escalation = setTimeout(
        () => signalNamespaceProcessGroup(child, "SIGKILL"),
        5_000,
      );
    };
    const timeout =
      config.timeoutMs === undefined
        ? undefined
        : setTimeout(() => terminate("timeout"), config.timeoutMs);
    const outputLimit = config.maxOutputBytes;
    let outputBytes = 0;
    let outputSecretMatches = 0;
    let outputTail = "";
    const flushOutput = new Set<() => void>();
    const observeOutput = (
      stream: NodeJS.ReadableStream | null,
      target: NodeJS.WritableStream,
    ) => {
      if (stream === null) return;
      const redactor = createStreamingSecretRedactor((text) =>
        target.write(text),
      );
      let forwarding = true;
      flushOutput.add(() => redactor.flush());
      stream.on("data", (chunk: Buffer | string) => {
        const text = String(chunk);
        outputBytes += Buffer.byteLength(chunk);
        const inspectable = `${outputTail}${text}`;
        if (sanitizeSecretString(inspectable) !== inspectable)
          outputSecretMatches += 1;
        outputTail = inspectable.slice(-512);
        if (forwarding) {
          if (outputLimit === undefined || outputBytes <= outputLimit)
            redactor.write(text);
          else {
            forwarding = false;
          }
        }
        if (
          outputLimit !== undefined &&
          outputBytes > outputLimit &&
          !outputLimitExceeded
        )
          terminate("output");
      });
    };
    observeOutput(child.stdout, process.stdout);
    observeOutput(child.stderr, process.stderr);
    for (const signal of signals) {
      const handler = () => terminate("interrupt", signal);
      handlers.set(signal, handler);
      process.once(signal, handler);
    }

    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (escalation !== undefined) clearTimeout(escalation);
      for (const [signal, handler] of handlers)
        process.removeListener(signal, handler);
    };

    child.once("error", (error) => {
      cleanup();
      reject(
        new EgressRunError(
          `Failed to start Linux namespace backend: ${error.message}`,
          "Verify that unshare is installed and executable.",
        ),
      );
    });
    // `close` waits for the stdout/stderr pipes, so a secret prefix cannot be
    // flushed before its remaining bytes are delivered.
    child.once("close", (code, signal) => {
      cleanup();
      for (const flush of flushOutput) flush();
      resolve({
        exitCode: code ?? signalExitCode(signal),
        timedOut,
        outputLimitExceeded,
        outputBytes,
        outputSecretMatches,
        ...(interruptedBy === undefined ? {} : { interruptedBy }),
      });
    });
  });
}

function runProcess(
  executable: string,
  args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) =>
      resolve({ exitCode: -1, stdout, stderr: error.message }),
    );
    child.once("exit", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function uniqueHosts(hosts: string[]): string[] {
  return [...new Set(hosts.map((host) => host.toLowerCase()))];
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? sanitizeSecretString(error.message).replace(
        /(?:Bearer\s+)?\S*(?:token|secret|key)\S*/gi,
        "***",
      )
    : "Unknown error";
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const signals: Partial<Record<NodeJS.Signals, number>> = {
    SIGINT: 2,
    SIGTERM: 15,
    SIGHUP: 1,
    SIGBREAK: 21,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGCHLD: 17,
    SIGCONT: 18,
    SIGSTOP: 19,
    SIGTSTP: 20,
    SIGTTIN: 21,
    SIGTTOU: 22,
    SIGURG: 23,
    SIGXCPU: 24,
    SIGXFSZ: 25,
    SIGVTALRM: 26,
    SIGPROF: 27,
    SIGWINCH: 28,
    SIGIO: 29,
    SIGPOLL: 29,
    SIGPWR: 30,
    SIGSYS: 31,
  };
  return 128 + (signals[signal] ?? 1);
}

function signalNamespaceProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!isErrorCode(error, "ESRCH")) child.kill(signal);
  }
}

function createStreamingSecretRedactor(write: (text: string) => void): {
  write(text: string): void;
  flush(): void;
} {
  let pending = "";
  let redacting: RegExp | undefined;

  const consume = (text: string) => {
    for (const character of text) {
      if (redacting !== undefined) {
        if (redacting.test(character)) continue;
        redacting = undefined;
      }
      pending += character;
      const normalized = pending.toLowerCase();
      const matchedPrefix = STREAM_SECRET_PREFIXES.find((prefix) =>
        normalized.endsWith(prefix),
      );
      if (matchedPrefix !== undefined) {
        write(`${pending.slice(0, -matchedPrefix.length)}***`);
        pending = "";
        redacting = /[A-Za-z0-9_.-]/;
        continue;
      }
      if (normalized.endsWith("bearer ")) {
        write(`${pending.slice(0, -"bearer ".length)}Bearer ***`);
        pending = "";
        redacting = /\S/;
        continue;
      }
      flushSafePrefix();
    }
  };

  const flushSafePrefix = () => {
    const normalized = pending.toLowerCase();
    const suffixLength = Math.max(
      0,
      ...[...STREAM_SECRET_PREFIXES, "bearer "].map((prefix) => {
        for (
          let length = Math.min(prefix.length - 1, normalized.length);
          length > 0;
          length -= 1
        ) {
          if (prefix.startsWith(normalized.slice(-length))) return length;
        }
        return 0;
      }),
    );
    if (pending.length > suffixLength) {
      write(pending.slice(0, pending.length - suffixLength));
      pending = pending.slice(pending.length - suffixLength);
    }
  };

  return {
    write: consume,
    flush() {
      if (redacting === undefined) write(pending);
      pending = "";
    },
  };
}
