import { describe, expect, it } from "vitest";
import { CliError } from "../src/cli/errors.js";
import { parseCliArgs } from "../src/cli/parser.js";

describe("CLI parser", () => {
  it("parses start flags", () => {
    expect(parseCliArgs(["start", "--port", "8443", "--host", "127.0.0.1", "--model", "gemini-flash", "--offline", "--https", "--allow-external-llm"])).toEqual({
      name: "start",
      options: { port: 8443, host: "127.0.0.1", model: "gemini-flash", offline: true, https: true, allowExternalLlm: true }
    });
    expect(parseCliArgs(["start", "--open"])).toEqual({ name: "start", options: { open: true } });
  });

  it("defaults to start", () => {
    expect(parseCliArgs([])).toEqual({ name: "start", options: {} });
  });

  it("parses clear targets", () => {
    expect(parseCliArgs(["clear", "cache"])).toEqual({ name: "clear", target: "cache" });
    expect(parseCliArgs(["clear", "state"])).toEqual({ name: "clear", target: "state" });
    expect(parseCliArgs(["clear", "events"])).toEqual({ name: "clear", target: "events" });
    expect(parseCliArgs(["clear", "all"])).toEqual({ name: "clear", target: "all" });
  });

  it("parses model commands", () => {
    expect(parseCliArgs(["model", "get"])).toEqual({ name: "model-get" });
    expect(parseCliArgs(["model", "set", "gemini-flash"])).toEqual({ name: "model-set", model: "gemini-flash" });
  });

  it("parses provider commands", () => {
    expect(parseCliArgs(["providers", "list"])).toEqual({ name: "providers-list" });
    expect(parseCliArgs(["providers", "inspect", "stripe"])).toEqual({ name: "providers-inspect", provider: "stripe" });
  });

  it("parses doctor and init", () => {
    expect(parseCliArgs(["doctor", "--port", "8081"])).toEqual({ name: "doctor", options: { port: 8081 } });
    expect(parseCliArgs(["doctor", "--json"])).toEqual({ name: "doctor", options: { json: true } });
    expect(parseCliArgs(["doctor", "--egress"])).toEqual({ name: "doctor", options: { egress: true } });
    expect(parseCliArgs(["doctor", "--egress", "--json"])).toEqual({ name: "doctor", options: { egress: true, json: true } });
    expect(parseCliArgs(["init"])).toEqual({ name: "init" });
  });

  it("parses run commands without passing through a shell", () => {
    expect(parseCliArgs(["run", "--port", "9080", "--allow-host", "localhost", "--", "node", "script.mjs", "--secret=sk_live_fixture"])).toEqual({
      name: "run",
      options: {
        port: 9080,
        allowHosts: ["localhost"],
        command: ["node", "script.mjs", "--secret=sk_live_fixture"]
      }
    });
    expect(parseCliArgs(["run", "--policy", "ghostapi.policy.yaml", "--", "node", "script.mjs"])).toEqual({
      name: "run",
      options: { allowHosts: [], policyPath: "ghostapi.policy.yaml", command: ["node", "script.mjs"] }
    });
  });

  it("parses policy validation and explain commands", () => {
    expect(parseCliArgs(["policy", "validate", "--file", "configs/ghostapi.policy.yaml"])).toEqual({ name: "policy-validate", file: "configs/ghostapi.policy.yaml" });
    expect(parseCliArgs(["policy", "explain", "network", "api.stripe.com", "--provider", "stripe"])).toEqual({ name: "policy-explain", event: { type: "network", host: "api.stripe.com", provider: "stripe" } });
    expect(parseCliArgs(["policy", "explain", "stripe.card_declined"])).toEqual({ name: "policy-explain", event: { type: "scenario", scenarioId: "stripe.card_declined", completedScenarioIds: [] } });
    expect(parseCliArgs(["policy", "explain", "report", "1", "0"])).toEqual({ name: "policy-explain", event: { type: "report", productionEgressAttempts: 1, forbiddenCredentialMatches: 0 } });
  });

  it("parses setup and mcp", () => {
    expect(parseCliArgs(["setup"])).toEqual({ name: "setup", options: {} });
    expect(parseCliArgs(["setup", "--write"])).toEqual({ name: "setup", options: { write: true } });
    expect(parseCliArgs(["mcp"])).toEqual({ name: "mcp" });
  });

  it("parses open", () => {
    expect(parseCliArgs(["open", "--port", "8081", "--host", "localhost", "--https"])).toEqual({ name: "open", options: { port: 8081, host: "localhost", https: true } });
  });

  it("parses report", () => {
    expect(parseCliArgs(["report"])).toEqual({ name: "report" });
  });

  it("parses evidence commands", () => {
    expect(parseCliArgs(["evidence", "generate", "--policy", "ghostapi.policy.yaml", "--run", ".ghostapi/runs/1/run.json", "--out", ".ghostapi/reports/1.json", "--contract-baseline", "base.contract.json", "--contract-candidate", "head.contract.json", "--ci", "--json"])).toEqual({
      name: "evidence-generate",
      options: { policyPath: "ghostapi.policy.yaml", runPath: ".ghostapi/runs/1/run.json", outPath: ".ghostapi/reports/1.json", contractBaselinePath: "base.contract.json", contractCandidatePath: "head.contract.json", ci: true, json: true }
    });
    expect(parseCliArgs(["evidence", "view", ".ghostapi/reports/1.json", "--json"])).toEqual({ name: "evidence-view", options: { path: ".ghostapi/reports/1.json", json: true } });
    expect(parseCliArgs(["evidence", "compare", "left.json", "right.json"])).toEqual({ name: "evidence-compare", options: { leftPath: "left.json", rightPath: "right.json" } });
  });

  it("parses explicit recording approval and offline replay commands", () => {
    expect(parseCliArgs(["record", "--input", "capture.har", "--allow-sandbox-host", "api.stripe.com", "--allow-sandbox-host", "payments.sandbox.example", "--out", ".ghostapi/scenarios/payment.bundle.json", "--title", "Payment flow", "--pii", "emails,phones", "--approve"])).toEqual({
      name: "record",
      options: {
        inputPath: "capture.har",
        allowedSandboxHosts: ["api.stripe.com", "payments.sandbox.example"],
        outPath: ".ghostapi/scenarios/payment.bundle.json",
        title: "Payment flow",
        pii: "emails,phones",
        approve: true
      }
    });
    expect(parseCliArgs(["replay", "payment.bundle.json", "--requests", "requests.json", "--json"])).toEqual({ name: "replay", options: { bundlePath: "payment.bundle.json", requestsPath: "requests.json", json: true } });
  });

  it("parses bounded local contract import and CI diff commands", () => {
    expect(parseCliArgs(["contract", "import-openapi", "--input", "openapi.json", "--out", ".ghostapi/contracts/openapi.contract.json", "--title", "Orders"])).toEqual({
      name: "contract-import-openapi",
      options: { inputPath: "openapi.json", outPath: ".ghostapi/contracts/openapi.contract.json", title: "Orders" }
    });
    expect(parseCliArgs(["contract", "import-har", "--input", "capture.har", "--allow-sandbox-host", "api.sandbox.example", "--contract-out", "contract.json", "--approve"])).toEqual({
      name: "contract-import-har",
      options: { inputPath: "capture.har", allowedSandboxHosts: ["api.sandbox.example"], contractOutPath: "contract.json", approve: true }
    });
    expect(parseCliArgs(["contract", "diff", "--baseline", "base.contract.json", "--candidate", "head.contract.json", "--policy", "ghostapi.policy.yaml", "--ci", "--json"])).toEqual({
      name: "contract-diff",
      options: { baselinePath: "base.contract.json", candidatePath: "head.contract.json", policyPath: "ghostapi.policy.yaml", ci: true, json: true }
    });
  });

  it("parses eval commands", () => {
    expect(parseCliArgs(["eval", "--template", "retry-after", "--evidence", ".ghostapi/reports/latest.json", "--out", ".ghostapi/reports/retry.eval.json", "--ci", "--json"])).toEqual({
      name: "eval",
      options: { template: "retry-after", evidencePath: ".ghostapi/reports/latest.json", outPath: ".ghostapi/reports/retry.eval.json", ci: true, json: true }
    });
    expect(parseCliArgs(["eval", "--spec", "agent.eval.json"])).toEqual({ name: "eval", options: { specPath: "agent.eval.json" } });
  });

  it("parses synthetic world lifecycle commands", () => {
    expect(parseCliArgs(["world", "create", "--id", "billing-world", "--seed", "fixed-seed", "--title", "Billing recovery", "--json"])).toEqual({
      name: "world-create",
      options: { id: "billing-world", seed: "fixed-seed", title: "Billing recovery", json: true }
    });
    expect(parseCliArgs(["world", "inspect", "billing-world", "--json"])).toEqual({ name: "world-inspect", id: "billing-world", json: true });
    expect(parseCliArgs(["world", "reset", "billing-world"])).toEqual({ name: "world-reset", id: "billing-world" });
    expect(parseCliArgs(["world", "fork", "billing-world", "--id", "billing-fork", "--title", "Fork"])).toEqual({ name: "world-fork", sourceId: "billing-world", options: { id: "billing-fork", title: "Fork" } });
  });

  it("parses synthetic action gateway commands", () => {
    expect(parseCliArgs(["action", "submit", "--action", "action.json", "--approval", "approval.json", "--policy", "ghostapi.policy.yaml", "--json"])).toEqual({
      name: "action-submit",
      options: { actionPath: "action.json", approvalPath: "approval.json", policyPath: "ghostapi.policy.yaml", json: true }
    });
    expect(parseCliArgs(["action", "inspect", "action-one", "--json"])).toEqual({ name: "action-inspect", actionId: "action-one", json: true });
    expect(parseCliArgs(["action", "execute", "--action", "action.json", "--policy", "ghostapi.policy.yaml", "--actor", "agent-one", "--workload", "checkout-worker"])).toEqual({
      name: "action-execute",
      options: { actionPath: "action.json", policyPath: "ghostapi.policy.yaml", actorId: "agent-one", workloadId: "checkout-worker" }
    });
  });

  it("parses local opt-in telemetry commands", () => {
    expect(parseCliArgs(["telemetry", "status"])).toEqual({ name: "telemetry", action: "status" });
    expect(parseCliArgs(["telemetry", "enable", "--json"])).toEqual({ name: "telemetry", action: "enable", json: true });
    expect(parseCliArgs(["telemetry", "disable"])).toEqual({ name: "telemetry", action: "disable" });
    expect(parseCliArgs(["telemetry", "export", "--json"])).toEqual({ name: "telemetry", action: "export", json: true });
  });

  it("throws actionable errors for invalid user input", () => {
    expect(() => parseCliArgs(["start", "--port", "nope"])).toThrow(CliError);
    expect(() => parseCliArgs(["clear", "logs"])).toThrow("Unknown clear target");
    expect(() => parseCliArgs(["model", "set"])).toThrow("Missing model name");
    expect(() => parseCliArgs(["providers", "inspect"])).toThrow("Missing provider name");
    expect(() => parseCliArgs(["doctor", "--port", "nope"])).toThrow("Invalid --port");
    expect(() => parseCliArgs(["run", "node", "script.mjs"])).toThrow("Missing command separator");
    expect(() => parseCliArgs(["run", "--"])).toThrow("Missing command for ghostapi run");
    expect(() => parseCliArgs(["run", "--allow-host", "localhost", "--unknown", "--", "node"])).toThrow("Unknown run option");
    expect(() => parseCliArgs(["policy", "validate", "--wat"])).toThrow("Unexpected policy argument");
    expect(() => parseCliArgs(["policy", "explain", "network"])).toThrow("Missing network host");
    expect(() => parseCliArgs(["policy", "explain", "report", "-1", "0"])).toThrow("Report explain requires two or three non-negative integer counts");
    expect(() => parseCliArgs(["evidence", "view"])).toThrow("Missing evidence report path");
    expect(() => parseCliArgs(["evidence", "compare", "left.json"])).toThrow("Missing evidence report paths");
    expect(() => parseCliArgs(["record", "--input", "capture.json"])).toThrow("sandbox host allowlist");
    expect(() => parseCliArgs(["record", "--input", "capture.json", "--allow-sandbox-host", "api.sandbox.example", "--pii", "names"])).toThrow("Invalid --pii");
    expect(() => parseCliArgs(["replay", "bundle.json"])).toThrow("Missing replay requests input");
    expect(() => parseCliArgs(["evidence", "generate", "--contract-baseline", "base.contract.json"])).toThrow("requires both contract paths");
    expect(() => parseCliArgs(["contract", "diff", "--baseline", "base.contract.json"])).toThrow("requires baseline and candidate");
    expect(() => parseCliArgs(["eval", "--template", "unknown"])).toThrow("Unknown eval template");
    expect(() => parseCliArgs(["eval", "--template", "retry-after", "--spec", "agent.eval.json"])).toThrow("exactly one");
    expect(() => parseCliArgs(["world", "create", "--id", "missing-seed"])).toThrow("requires --id and --seed");
    expect(() => parseCliArgs(["world", "fork", "source"])).toThrow("requires --id");
    expect(() => parseCliArgs(["action", "submit", "--action", "action.json"])).toThrow("requires --action, --approval, and --policy");
    expect(() => parseCliArgs(["action", "execute", "--action", "action.json", "--policy", "ghostapi.policy.yaml"])).toThrow("requires --action, --policy, --actor, and --workload");
    expect(() => parseCliArgs(["telemetry", "upload"])).toThrow("Unknown telemetry command");
  });
});
