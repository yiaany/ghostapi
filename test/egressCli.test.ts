import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EgressCapabilityReport } from "../src/egress/capabilities.js";

const cliPath = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

describe("egress doctor CLI", () => {
  it("emits a parseable, non-isolated JSON capability report", async () => {
    const output = await runEgressDoctor();
    const report = JSON.parse(output) as EgressCapabilityReport;

    expect(report.schemaVersion).toBe(1);
    expect(report.isolated).toBe(false);
    expect(report.currentGuarantee).toBe("http-proxy-guidance");
    expect(report.globalStateChanged).toBe(false);
    expect(report.capabilities).toContainEqual(expect.objectContaining({ id: "http-proxy-guidance", status: "available" }));
  });
});

function runEgressDoctor(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, "doctor", "--egress", "--json"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Egress doctor exited ${code}: ${stderr}`)));
  });
}
