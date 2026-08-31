import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EgressCapabilityReport } from "../src/egress/capabilities.js";

const cliPath = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

describe("egress doctor CLI", () => {
  it("emits a parseable environment doctor report", async () => {
    const output = await runDoctorJson();
    const report = JSON.parse(output) as {
      schemaVersion: 1;
      checks: Array<{ label: string; status: string; detail: string }>;
      egress: EgressCapabilityReport;
    };

    expect(report.schemaVersion).toBe(1);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ label: "Node version", status: "ok" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ label: "Port availability" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        label: "Enforcement capability",
        status: "warn",
      }),
    );
    expect(report.egress.isolated).toBe(false);
  });

  it("emits a parseable, non-isolated JSON capability report", async () => {
    const output = await runEgressDoctor();
    const report = JSON.parse(output) as EgressCapabilityReport;

    expect(report.schemaVersion).toBe(1);
    expect(report.isolated).toBe(false);
    expect(report.currentGuarantee).toBe("http-proxy-guidance");
    expect(report.globalStateChanged).toBe(false);
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        id: "http-proxy-guidance",
        status: "available",
      }),
    );
  });

  it("explains busy port failures with remediation and docs", async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(0, "127.0.0.1", () => resolve());
    });
    const address = holder.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected TCP server address");

    try {
      const failure = await runCliExpectFailure([
        "start",
        "--host",
        "127.0.0.1",
        "--port",
        String(address.port),
      ]);
      expect(failure.stderr).toContain(
        `Port ${address.port} is already in use`,
      );
      expect(failure.stderr).toContain("Reason:");
      expect(failure.stderr).toContain("Remediation:");
      expect(failure.stderr).toContain("Docs:");
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});

function runDoctorJson(): Promise<string> {
  return runCli(["doctor", "--port", "65530", "--json"]);
}

function runEgressDoctor(): Promise<string> {
  return runCli(["doctor", "--egress", "--json"]);
}

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
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
      code === 0
        ? resolve(stdout)
        : reject(new Error(`Doctor exited ${code}: ${stderr}`)),
    );
  });
}

function runCliExpectFailure(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
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
      code === 0
        ? reject(new Error("Expected CLI command to fail."))
        : resolve({ stdout, stderr }),
    );
  });
}
