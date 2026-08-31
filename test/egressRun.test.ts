import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getDataDir } from "../src/config/dataPaths.js";
import { EgressRunError, runEgressCommand } from "../src/egress/run.js";

const targetPath = fileURLToPath(
  new URL("./fixtures/egressTarget.mjs", import.meta.url),
);
const cliPath = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const canRunLinuxNamespace =
  process.platform === "linux" &&
  (await canRun([
    "unshare",
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
  ]));
const hasCurl =
  process.platform === "linux" && (await canRun(["curl", "--version"]));
if (
  process.env.GHOSTAPI_REQUIRE_LINUX_EGRESS === "1" &&
  (!canRunLinuxNamespace || !hasCurl)
) {
  throw new Error(
    "Required Linux egress enforcement prerequisites are unavailable.",
  );
}

describe("ghostapi run Linux network namespace backend", () => {
  it("allows GhostAPI loopback and preserves the target exit code", async () => {
    if (!canRunLinuxNamespace) return expectEnforcementUnavailable();

    const result = await runTarget("ghostapi");
    expect(result.exitCode).toBe(0);
    await expectEvidence(result.evidencePath, "finished");

    const exited = await runTarget("exit", "23");
    expect(exited.exitCode).toBe(23);
  });

  it("blocks fetch, https, direct IP, and child-process bypass attempts", async () => {
    if (!canRunLinuxNamespace) return expectEnforcementUnavailable();

    for (const mode of [
      "fetch-external",
      "https-external",
      "direct-ip",
      "child-fetch",
    ]) {
      const result = await runTarget(mode);
      expect(result.exitCode, mode).toBe(0);
    }
  }, 15_000);

  it("blocks curl executed by the target", async () => {
    if (!canRunLinuxNamespace) return expectEnforcementUnavailable();

    const result = await runTarget("curl");
    expect(result.exitCode).toBe(hasCurl ? 0 : 1);
  });

  it("does not persist command arguments or secrets in evidence", async () => {
    if (!canRunLinuxNamespace) return expectEnforcementUnavailable();

    const result = await runTarget("exit", "0", "sk_live_should_not_persist");
    const evidence = await readFile(result.evidencePath, "utf8");

    expect(evidence).not.toContain("sk_live_should_not_persist");
    expect(JSON.parse(evidence)).toMatchObject({
      status: "finished",
      policy: { default: "deny" },
      command: { executable: "node", argumentCount: 4 },
    });
  });

  it("forwards interruption and finalizes run evidence", async () => {
    if (!canRunLinuxNamespace) return expectEnforcementUnavailable();

    const before = new Set(await listRunDirectories());
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        cliPath,
        "run",
        "--",
        process.execPath,
        "-e",
        "setInterval(() => undefined, 1000)",
      ],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const evidencePath = await waitForNewRunningEvidence(before);
    child.kill("SIGTERM");
    const exitCode = await waitForExit(child);

    expect(exitCode).toBe(143);
    await expectEvidence(evidencePath, "finished");
    await expect(readFile(evidencePath, "utf8")).resolves.toContain(
      '"type": "run-interrupted"',
    );
  }, 15_000);

  it("terminates the namespace process tree for eval timeout and output limits", async () => {
    if (!canRunLinuxNamespace) return expectEnforcementUnavailable();

    const timedOut = await runEgressCommand({
      command: [process.execPath, targetPath, "wait"],
      allowHosts: [],
      timeoutMs: 100,
    });
    const timeoutEvidence = JSON.parse(
      await readFile(timedOut.evidencePath, "utf8"),
    ) as { output?: { timedOut?: boolean }; events?: Array<{ type?: string }> };
    expect(timeoutEvidence.output?.timedOut).toBe(true);
    expect(timeoutEvidence.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run-timeout" }),
      ]),
    );

    const limited = await runEgressCommand({
      command: [process.execPath, targetPath, "large-output"],
      allowHosts: [],
      maxOutputBytes: 128,
    });
    const outputEvidence = JSON.parse(
      await readFile(limited.evidencePath, "utf8"),
    ) as {
      output?: { limitExceeded?: boolean };
      events?: Array<{ type?: string }>;
    };
    expect(outputEvidence.output?.limitExceeded).toBe(true);
    expect(outputEvidence.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run-output-limit-exceeded" }),
      ]),
    );
  }, 15_000);

  it("summarizes secret-shaped target output without persisting raw output", async () => {
    if (!canRunLinuxNamespace) return expectEnforcementUnavailable();

    const result = await runEgressCommand({
      command: [process.execPath, targetPath, "secret-output"],
      allowHosts: [],
      maxOutputBytes: 1024,
    });
    const evidence = await readFile(result.evidencePath, "utf8");

    expect(JSON.parse(evidence)).toMatchObject({
      output: { secretMatches: 1 },
    });
    expect(evidence).not.toContain("sk_live_output_should_not_persist");
  });

  it("redacts secret-shaped target output before terminal forwarding", async () => {
    if (!canRunLinuxNamespace) return expectEnforcementUnavailable();

    const result = await runCli([
      "run",
      "--",
      process.execPath,
      targetPath,
      "split-secret-output",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("***");
    expect(result.stdout).toContain("\nsafe output\n");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      "sk_live_split_should_not_persist",
    );
  }, 15_000);
});

describe("ghostapi run degraded modes", () => {
  it("fails closed for an external allowlist entry", async () => {
    await expect(
      runEgressCommand({
        command: [process.execPath, targetPath, "exit", "0"],
        allowHosts: ["api.stripe.com"],
      }),
    ).rejects.toMatchObject({
      name: EgressRunError.name,
      message:
        "The Linux namespace backend cannot allow external host api.stripe.com.",
    });
  });

  it("applies an explicit policy before platform/backend startup", async () => {
    await expect(
      runEgressCommand({
        command: [process.execPath, targetPath, "exit", "0", "sk_live_secret"],
        allowHosts: [],
        policyPath: "test/fixtures/strict.policy.yaml",
      }),
    ).rejects.toMatchObject({
      name: EgressRunError.name,
      message: "Policy denied credential before launching the target.",
    });
  });

  it("rejects invalid public resource limits before backend startup", async () => {
    await expect(
      runEgressCommand({
        command: [process.execPath, targetPath, "exit", "0"],
        allowHosts: [],
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({
      name: EgressRunError.name,
      message: "Run timeout must be an integer between 100 and 300000 ms.",
    });
    await expect(
      runEgressCommand({
        command: [process.execPath, targetPath, "exit", "0"],
        allowHosts: [],
        maxOutputBytes: -1,
      }),
    ).rejects.toMatchObject({
      name: EgressRunError.name,
      message:
        "Run output limit must be an integer between 0 and 10485760 bytes.",
    });
  });

  it("fails closed where no enforcement backend exists", async () => {
    if (!canRunLinuxNamespace) return expectEnforcementUnavailable();

    const result = await runTarget("exit", "0");
    expect(result.exitCode).toBe(0);
  });
});

function runTarget(mode: string, ...args: string[]) {
  return runEgressCommand({
    command: [process.execPath, targetPath, mode, ...args],
    allowHosts: [],
  });
}

async function expectEnforcementUnavailable(): Promise<void> {
  const expectedMessage =
    process.platform === "linux"
      ? "Linux user, mount, and network namespace preflight failed"
      : "enforcement is unavailable";
  await expect(runTarget("exit", "0")).rejects.toMatchObject({
    name: EgressRunError.name,
    message: expect.stringContaining(expectedMessage),
  });
}

async function expectEvidence(path: string, status: string): Promise<void> {
  await expect(readFile(path, "utf8")).resolves.toContain(
    `"status": "${status}"`,
  );
}

function canRun([executable, ...args]: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(executable!, args, { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
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

async function listRunDirectories(): Promise<string[]> {
  try {
    return await readdir(join(getDataDir(), "runs"));
  } catch {
    return [];
  }
}

async function waitForNewRunningEvidence(before: Set<string>): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const directories = await listRunDirectories();
    const directory = directories.find((candidate) => !before.has(candidate));
    if (directory !== undefined) {
      const evidencePath = join(getDataDir(), "runs", directory, "run.json");
      try {
        if (
          (await readFile(evidencePath, "utf8")).includes('"status": "running"')
        )
          return evidencePath;
      } catch {
        // The run directory exists before its first atomic evidence write.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for ghostapi run to start.");
}
