import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getDataDir } from "../src/config/dataPaths.js";
import { EgressRunError, runEgressCommand } from "../src/egress/run.js";

const targetPath = fileURLToPath(new URL("./fixtures/egressTarget.mjs", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const canRunLinuxNamespace = process.platform === "linux" && await canRun(["unshare", "--user", "--map-root-user", "--net", "--mount", "--pid", "--fork", "--kill-child=SIGTERM", "--mount-proc", "--propagation", "private", "--", "true"]);
const hasCurl = process.platform === "linux" && await canRun(["curl", "--version"]);
const linuxIt = canRunLinuxNamespace ? it : it.skip;

describe("ghostapi run Linux network namespace backend", () => {
  linuxIt("allows GhostAPI loopback and preserves the target exit code", async () => {
    const result = await runTarget("ghostapi");
    expect(result.exitCode).toBe(0);
    await expectEvidence(result.evidencePath, "finished");

    const exited = await runTarget("exit", "23");
    expect(exited.exitCode).toBe(23);
  });

  linuxIt("blocks fetch, https, direct IP, and child-process bypass attempts", async () => {
    for (const mode of ["fetch-external", "https-external", "direct-ip", "child-fetch"]) {
      const result = await runTarget(mode);
      expect(result.exitCode, mode).toBe(0);
    }
  });

  (canRunLinuxNamespace && hasCurl ? it : it.skip)("blocks curl executed by the target", async () => {
    const result = await runTarget("curl");
    expect(result.exitCode).toBe(0);
  });

  linuxIt("does not persist command arguments or secrets in evidence", async () => {
    const result = await runTarget("exit", "0", "sk_live_should_not_persist");
    const evidence = await readFile(result.evidencePath, "utf8");

    expect(evidence).not.toContain("sk_live_should_not_persist");
    expect(JSON.parse(evidence)).toMatchObject({
      status: "finished",
      policy: { default: "deny" },
      command: { executable: "node", argumentCount: 4 }
    });
  });

  linuxIt("forwards interruption and finalizes run evidence", async () => {
    const before = new Set(await listRunDirectories());
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, "run", "--", process.execPath, "-e", "setInterval(() => undefined, 1000)"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const evidencePath = await waitForNewRunningEvidence(before);
    child.kill("SIGTERM");
    const exitCode = await waitForExit(child);

    expect(exitCode).toBe(143);
    await expectEvidence(evidencePath, "finished");
  });
});

describe("ghostapi run degraded modes", () => {
  it("fails closed for an external allowlist entry", async () => {
    await expect(runEgressCommand({ command: [process.execPath, targetPath, "exit", "0"], allowHosts: ["api.stripe.com"] })).rejects.toMatchObject({
      name: EgressRunError.name,
      message: "The Linux namespace backend cannot allow external host api.stripe.com."
    });
  });

  it("applies an explicit policy before platform/backend startup", async () => {
    await expect(runEgressCommand({ command: [process.execPath, targetPath, "exit", "0", "sk_live_secret"], allowHosts: [], policyPath: "test/fixtures/strict.policy.yaml" })).rejects.toMatchObject({
      name: EgressRunError.name,
      message: "Policy denied credential before launching the target."
    });
  });

  (process.platform === "linux" ? it.skip : it)("fails closed where no enforcement backend exists", async () => {
    await expect(runEgressCommand({ command: [process.execPath, targetPath, "exit", "0"], allowHosts: [] })).rejects.toMatchObject({
      name: EgressRunError.name,
      message: expect.stringContaining("enforcement is unavailable")
    });
  });
});

function runTarget(mode: string, ...args: string[]) {
  return runEgressCommand({ command: [process.execPath, targetPath, mode, ...args], allowHosts: [] });
}

async function expectEvidence(path: string, status: string): Promise<void> {
  await expect(readFile(path, "utf8")).resolves.toContain(`"status": "${status}"`);
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
        if ((await readFile(evidencePath, "utf8")).includes('"status": "running"')) return evidencePath;
      } catch {
        // The run directory exists before its first atomic evidence write.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for ghostapi run to start.");
}
