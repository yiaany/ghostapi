import { CliError } from "./errors.js";

export type CliCommand =
  | { name: "start"; options: StartOptions }
  | { name: "clear"; target: ClearTarget }
  | { name: "model-get" }
  | { name: "model-set"; model: string }
  | { name: "providers-list" }
  | { name: "providers-inspect"; provider: string }
  | { name: "doctor"; options: DoctorOptions }
  | { name: "run"; options: RunOptions }
  | { name: "policy-validate"; file?: string }
  | { name: "policy-explain"; file?: string; event: PolicyExplainInput }
  | { name: "evidence-generate"; options: EvidenceGenerateOptions }
  | { name: "evidence-view"; options: EvidenceViewOptions }
  | { name: "evidence-compare"; options: EvidenceCompareOptions }
  | { name: "record"; options: RecordOptions }
  | { name: "replay"; options: ReplayOptions }
  | { name: "contract-import-openapi"; options: ContractImportOpenApiOptions }
  | { name: "contract-import-har"; options: ContractImportHarOptions }
  | { name: "contract-diff"; options: ContractDiffOptions }
  | { name: "eval"; options: EvalOptions }
  | { name: "world-create"; options: WorldCreateOptions }
  | { name: "world-inspect"; id: string; json?: boolean }
  | { name: "world-reset"; id: string; json?: boolean }
  | { name: "world-fork"; sourceId: string; options: WorldForkOptions }
  | { name: "action-submit"; options: ActionSubmitOptions }
  | { name: "action-inspect"; actionId: string; json?: boolean }
  | { name: "action-execute"; options: ActionExecuteOptions }
  | { name: "telemetry"; action: TelemetryAction; json?: boolean }
  | { name: "init" }
  | { name: "setup"; options: SetupOptions }
  | { name: "open"; options: OpenOptions }
  | { name: "report" }
  | { name: "mcp" }
  | { name: "help" };

export type StartOptions = {
  host?: string;
  port?: number;
  model?: string;
  offline?: boolean;
  https?: boolean;
  allowExternalLlm?: boolean;
  open?: boolean;
};

export type DoctorOptions = {
  port?: number;
  egress?: boolean;
  json?: boolean;
};

export type RunOptions = {
  port?: number;
  allowHosts: string[];
  policyPath?: string;
  command: string[];
};

export type PolicyExplainInput =
  | { type: "network"; host: string; provider?: string }
  | { type: "credential"; value: string }
  | { type: "scenario"; scenarioId: string; completedScenarioIds: string[] }
  | { type: "enforcement"; mode: "linux-network-namespace" | "proxy-guidance" }
  | { type: "report"; productionEgressAttempts: number; forbiddenCredentialMatches: number; breakingContractChanges?: number };

export type EvidenceGenerateOptions = {
  policyPath?: string;
  runPath?: string;
  outPath?: string;
  contractBaselinePath?: string;
  contractCandidatePath?: string;
  ci?: boolean;
  json?: boolean;
};

export type EvidenceViewOptions = {
  path: string;
  json?: boolean;
};

export type EvidenceCompareOptions = {
  leftPath: string;
  rightPath: string;
  json?: boolean;
};

export type RecordOptions = {
  inputPath: string;
  outPath?: string;
  title?: string;
  allowedSandboxHosts: string[];
  pii?: string;
  approve?: boolean;
};

export type ReplayOptions = {
  bundlePath: string;
  requestsPath: string;
  json?: boolean;
};

export type ContractImportOpenApiOptions = {
  inputPath: string;
  outPath?: string;
  title?: string;
};

export type ContractImportHarOptions = RecordOptions & { contractOutPath?: string };

export type ContractDiffOptions = {
  baselinePath: string;
  candidatePath: string;
  policyPath?: string;
  ci?: boolean;
  json?: boolean;
};

export type EvalOptions = {
  specPath?: string;
  template?: "retry-after" | "duplicate-payment" | "webhook-signature" | "no-secret-logs" | "timeout-recovery" | "no-production-bypass";
  evidencePath?: string;
  outPath?: string;
  ci?: boolean;
  json?: boolean;
};

export type WorldCreateOptions = {
  id: string;
  seed: string;
  title?: string;
  json?: boolean;
};

export type WorldForkOptions = {
  id: string;
  title?: string;
  json?: boolean;
};

export type ActionSubmitOptions = {
  actionPath: string;
  approvalPath: string;
  policyPath: string;
  json?: boolean;
};

export type ActionExecuteOptions = {
  actionPath: string;
  policyPath: string;
  actorId: string;
  workloadId: string;
  json?: boolean;
};

export type SetupOptions = {
  write?: boolean;
};

export type OpenOptions = {
  host?: string;
  port?: number;
  https?: boolean;
};

export type ClearTarget = "cache" | "state" | "events" | "all";
export type TelemetryAction = "status" | "enable" | "disable" | "export";

export function parseCliArgs(args: string[]): CliCommand {
  const [command = "start", subcommand, ...rest] = args;

  if (command === "--help" || command === "-h" || command === "help") {
    return { name: "help" };
  }

  if (command === "start") {
    return { name: "start", options: parseStartOptions(args.slice(1)) };
  }

  if (command === "clear") {
    if (!isClearTarget(subcommand)) {
      throw new CliError(`Unknown clear target: ${subcommand ?? "<missing>"}`, "Use one of: ghostapi clear cache | state | events | all");
    }
    if (rest.length > 0) {
      throw new CliError(`Unexpected argument: ${rest[0]}`, `Use: ghostapi clear ${subcommand}`);
    }
    return { name: "clear", target: subcommand };
  }

  if (command === "model") {
    if (subcommand === "get") return { name: "model-get" };
    if (subcommand === "set") {
      const model = rest[0];
      if (!model) throw new CliError("Missing model name.", "Use: ghostapi model set gemini-flash");
      if (rest.length > 1) throw new CliError(`Unexpected argument: ${rest[1]}`, "Model names cannot contain spaces.");
      return { name: "model-set", model };
    }
    throw new CliError(`Unknown model command: ${subcommand ?? "<missing>"}`, "Use: ghostapi model get | ghostapi model set <model>");
  }

  if (command === "providers") {
    if (subcommand === "list") return { name: "providers-list" };
    if (subcommand === "inspect") {
      const provider = rest[0];
      if (!provider) throw new CliError("Missing provider name.", "Use: ghostapi providers inspect stripe");
      if (rest.length > 1) throw new CliError(`Unexpected argument: ${rest[1]}`, `Use: ghostapi providers inspect ${provider}`);
      return { name: "providers-inspect", provider };
    }
    throw new CliError(`Unknown providers command: ${subcommand ?? "<missing>"}`, "Use: ghostapi providers list | ghostapi providers inspect <name>");
  }

  if (command === "doctor") {
    return { name: "doctor", options: parseDoctorOptions(args.slice(1)) };
  }

  if (command === "run") {
    return { name: "run", options: parseRunOptions(args.slice(1)) };
  }

  if (command === "policy") {
    return parsePolicyCommand(args.slice(1));
  }

  if (command === "evidence") {
    return parseEvidenceCommand(args.slice(1));
  }

  if (command === "record") {
    return { name: "record", options: parseRecordOptions(args.slice(1)) };
  }

  if (command === "replay") {
    return { name: "replay", options: parseReplayOptions(args.slice(1)) };
  }

  if (command === "contract") {
    return parseContractCommand(args.slice(1));
  }

  if (command === "eval") {
    return { name: "eval", options: parseEvalOptions(args.slice(1)) };
  }

  if (command === "world") {
    return parseWorldCommand(args.slice(1));
  }

  if (command === "action") {
    return parseActionCommand(args.slice(1));
  }

  if (command === "telemetry") {
    return parseTelemetryCommand(args.slice(1));
  }

  if (command === "init") {
    if (args.length > 1) throw new CliError(`Unexpected argument: ${args[1]}`, "Use: ghostapi init");
    return { name: "init" };
  }

  if (command === "setup") {
    return { name: "setup", options: parseSetupOptions(args.slice(1)) };
  }

  if (command === "open") {
    return { name: "open", options: parseOpenOptions(args.slice(1)) };
  }

  if (command === "report") {
    if (args.length > 1) throw new CliError(`Unexpected argument: ${args[1]}`, "Use: ghostapi report");
    return { name: "report" };
  }

  if (command === "mcp") {
    if (args.length > 1) throw new CliError(`Unexpected argument: ${args[1]}`, "Use: ghostapi mcp");
    return { name: "mcp" };
  }

  throw new CliError(`Unknown command: ${args.join(" ")}`, "Run ghostapi --help to see available commands.");
}

function parseStartOptions(args: string[]): StartOptions {
  const options: StartOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--offline") {
      options.offline = true;
      continue;
    }
    if (arg === "--https") {
      options.https = true;
      continue;
    }
    if (arg === "--open") {
      options.open = true;
      continue;
    }
    if (arg === "--allow-external-llm") {
      options.allowExternalLlm = true;
      continue;
    }
    if (arg === "--host") {
      options.host = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--port") {
      options.port = parsePort(readValue(args, index, arg), "--port");
      index += 1;
      continue;
    }
    if (arg === "--model") {
      options.model = readValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new CliError(`Unknown start option: ${arg}`, "Supported options: --host, --port, --model, --offline, --https, --allow-external-llm, --open");
  }
  return options;
}

function parseSetupOptions(args: string[]): SetupOptions {
  const options: SetupOptions = {};
  for (const arg of args) {
    if (arg === "--write") {
      options.write = true;
      continue;
    }
    throw new CliError(`Unknown setup option: ${arg}`, "Supported option: --write");
  }
  return options;
}

function parseOpenOptions(args: string[]): OpenOptions {
  const options: OpenOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--https") {
      options.https = true;
      continue;
    }
    if (arg === "--host") {
      options.host = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--port") {
      options.port = parsePort(readValue(args, index, arg), "--port");
      index += 1;
      continue;
    }
    throw new CliError(`Unknown open option: ${arg}`, "Supported options: --host, --port, --https");
  }
  return options;
}

function parseDoctorOptions(args: string[]): DoctorOptions {
  const options: DoctorOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--egress") {
      options.egress = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--port") {
      options.port = parsePort(readValue(args, index, arg), "--port");
      index += 1;
      continue;
    }
    throw new CliError(`Unknown doctor option: ${arg}`, "Supported options: --port 8080, --egress, --json");
  }
  return options;
}

function parseRunOptions(args: string[]): RunOptions {
  const separatorIndex = args.indexOf("--");
  if (separatorIndex === -1) {
    throw new CliError("Missing command separator for ghostapi run.", "Use: ghostapi run [--port 8080] [--allow-host localhost] -- <command> [args...]");
  }

  const command = args.slice(separatorIndex + 1);
  if (command.length === 0) {
    throw new CliError("Missing command for ghostapi run.", "Use: ghostapi run -- <command> [args...]");
  }

  const options: RunOptions = { allowHosts: [], command };
  const optionArgs = args.slice(0, separatorIndex);
  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index]!;
    if (arg === "--port") {
      options.port = parsePort(readValue(optionArgs, index, arg), "--port");
      index += 1;
      continue;
    }
    if (arg === "--allow-host") {
      options.allowHosts.push(readValue(optionArgs, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--policy") {
      options.policyPath = readValue(optionArgs, index, arg);
      index += 1;
      continue;
    }
    throw new CliError(`Unknown run option: ${arg}`, "Supported options: --port 8080, --allow-host localhost, --policy ghostapi.policy.yaml");
  }

  return options;
}

function parsePolicyCommand(args: string[]): CliCommand {
  const [subcommand, ...rest] = args;
  if (subcommand === "validate") return { name: "policy-validate", file: parsePolicyFileOption(rest) };
  if (subcommand !== "explain") {
    throw new CliError(`Unknown policy command: ${subcommand ?? "<missing>"}`, "Use: ghostapi policy validate [--file ghostapi.policy.yaml] | ghostapi policy explain <scenario-id>|network <host>|credential <value>|enforcement <mode>|report <production-attempts> <credential-matches>");
  }

  const fileIndex = rest.indexOf("--file");
  let file: string | undefined;
  const eventArgs = [...rest];
  if (fileIndex !== -1) {
    file = readValue(rest, fileIndex, "--file");
    eventArgs.splice(fileIndex, 2);
  }
  if (eventArgs.includes("--file")) throw new CliError("Missing value for --file.", "Use --file ghostapi.policy.yaml.");
  if (eventArgs.length === 0) throw new CliError("Missing policy event.", "Use: ghostapi policy explain <scenario-id>|network <host>|credential <value>|enforcement <mode>|report <production-attempts> <credential-matches>");
  return { name: "policy-explain", file, event: parsePolicyExplainInput(eventArgs) };
}

function parsePolicyFileOption(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--file") return readValue(args, 0, "--file");
  throw new CliError(`Unexpected policy argument: ${args[0]}`, "Use: ghostapi policy validate [--file ghostapi.policy.yaml]");
}

function parseEvidenceCommand(args: string[]): CliCommand {
  const [subcommand, ...rest] = args;
  if (subcommand === "generate") return { name: "evidence-generate", options: parseEvidenceGenerateOptions(rest) };
  if (subcommand === "view") return { name: "evidence-view", options: parseEvidenceViewOptions(rest) };
  if (subcommand === "compare") return { name: "evidence-compare", options: parseEvidenceCompareOptions(rest) };
  throw new CliError(`Unknown evidence command: ${subcommand ?? "<missing>"}`, "Use: ghostapi evidence generate|view|compare");
}

function parseEvidenceGenerateOptions(args: string[]): EvidenceGenerateOptions {
  const options: EvidenceGenerateOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--policy") {
      options.policyPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--run") {
      options.runPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      options.outPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--contract-baseline") {
      options.contractBaselinePath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--contract-candidate") {
      options.contractCandidatePath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--ci") {
      options.ci = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new CliError(`Unknown evidence generate option: ${arg}`, "Supported options: --policy ghostapi.policy.yaml, --run .ghostapi/runs/<id>/run.json, --out .ghostapi/reports/report.json, --contract-baseline base.contract.json, --contract-candidate head.contract.json, --ci, --json");
  }
  if ((options.contractBaselinePath === undefined) !== (options.contractCandidatePath === undefined)) throw new CliError("Contract drift evidence requires both contract paths.", "Use --contract-baseline base.contract.json --contract-candidate head.contract.json.");
  return options;
}

function parseEvidenceViewOptions(args: string[]): EvidenceViewOptions {
  const path = args[0];
  if (!path) throw new CliError("Missing evidence report path.", "Use: ghostapi evidence view <report.json> [--json]");
  const rest = args.slice(1);
  if (rest.length === 0) return { path };
  if (rest.length === 1 && rest[0] === "--json") return { path, json: true };
  throw new CliError(`Unexpected evidence view argument: ${rest[0]}`, "Use: ghostapi evidence view <report.json> [--json]");
}

function parseEvidenceCompareOptions(args: string[]): EvidenceCompareOptions {
  const leftPath = args[0];
  const rightPath = args[1];
  if (!leftPath || !rightPath) throw new CliError("Missing evidence report paths.", "Use: ghostapi evidence compare <left.json> <right.json> [--json]");
  const rest = args.slice(2);
  if (rest.length === 0) return { leftPath, rightPath };
  if (rest.length === 1 && rest[0] === "--json") return { leftPath, rightPath, json: true };
  throw new CliError(`Unexpected evidence compare argument: ${rest[0]}`, "Use: ghostapi evidence compare <left.json> <right.json> [--json]");
}

function parseRecordOptions(args: string[]): RecordOptions {
  const options: Partial<RecordOptions> & { allowedSandboxHosts: string[] } = { allowedSandboxHosts: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--input") {
      options.inputPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      options.outPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--title") {
      options.title = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--allow-sandbox-host") {
      options.allowedSandboxHosts.push(readValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--pii") {
      const value = readValue(args, index, arg);
      if (!isPiiRuleSet(value)) throw new CliError(`Invalid --pii value: ${value}`, "Use: --pii emails,phones,addresses | emails | phones | addresses | none");
      options.pii = value;
      index += 1;
      continue;
    }
    if (arg === "--approve") {
      options.approve = true;
      continue;
    }
    throw new CliError(`Unknown record option: ${arg}`, "Supported options: --input capture.json, --allow-sandbox-host api.sandbox.example, --out bundle.json, --title title, --pii emails,phones,addresses, --approve");
  }
  if (!options.inputPath) throw new CliError("Missing recording input.", "Use: ghostapi record --input capture.json --allow-sandbox-host api.sandbox.example");
  if (options.allowedSandboxHosts.length === 0) throw new CliError("Recording requires an explicit sandbox host allowlist.", "Use: --allow-sandbox-host api.sandbox.example");
  return options as RecordOptions;
}

function parseReplayOptions(args: string[]): ReplayOptions {
  const bundlePath = args[0];
  if (!bundlePath) throw new CliError("Missing scenario bundle path.", "Use: ghostapi replay <bundle.json> --requests requests.json [--json]");
  const options: Partial<ReplayOptions> = { bundlePath };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--requests") {
      options.requestsPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new CliError(`Unknown replay option: ${arg}`, "Supported options: --requests requests.json, --json");
  }
  if (!options.requestsPath) throw new CliError("Missing replay requests input.", "Use: ghostapi replay <bundle.json> --requests requests.json [--json]");
  return options as ReplayOptions;
}

function parseContractCommand(args: string[]): CliCommand {
  const [subcommand, ...rest] = args;
  if (subcommand === "import-openapi") return { name: "contract-import-openapi", options: parseContractImportOpenApiOptions(rest) };
  if (subcommand === "import-har") return { name: "contract-import-har", options: parseContractImportHarOptions(rest) };
  if (subcommand === "diff") return { name: "contract-diff", options: parseContractDiffOptions(rest) };
  throw new CliError(`Unknown contract command: ${subcommand ?? "<missing>"}`, "Use: ghostapi contract import-openapi|import-har|diff");
}

function parseContractImportOpenApiOptions(args: string[]): ContractImportOpenApiOptions {
  const options: Partial<ContractImportOpenApiOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--input") { options.inputPath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--out") { options.outPath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--title") { options.title = readValue(args, index, arg); index += 1; continue; }
    throw new CliError(`Unknown contract import-openapi option: ${arg}`, "Supported options: --input openapi.json, --out contract.json, --title title");
  }
  if (!options.inputPath) throw new CliError("Missing OpenAPI input.", "Use: ghostapi contract import-openapi --input openapi.json");
  return options as ContractImportOpenApiOptions;
}

function parseContractImportHarOptions(args: string[]): ContractImportHarOptions {
  const base = parseRecordOptions(args.filter((arg, index) => arg !== "--contract-out" && args[index - 1] !== "--contract-out"));
  const contractOutIndex = args.indexOf("--contract-out");
  if (contractOutIndex === -1) return base;
  return { ...base, contractOutPath: readValue(args, contractOutIndex, "--contract-out") };
}

function parseContractDiffOptions(args: string[]): ContractDiffOptions {
  const options: Partial<ContractDiffOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--baseline") { options.baselinePath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--candidate") { options.candidatePath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--policy") { options.policyPath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--ci") { options.ci = true; continue; }
    if (arg === "--json") { options.json = true; continue; }
    throw new CliError(`Unknown contract diff option: ${arg}`, "Supported options: --baseline base.contract.json, --candidate head.contract.json, --policy ghostapi.policy.yaml, --ci, --json");
  }
  if (!options.baselinePath || !options.candidatePath) throw new CliError("Contract diff requires baseline and candidate paths.", "Use: ghostapi contract diff --baseline base.contract.json --candidate head.contract.json");
  return options as ContractDiffOptions;
}

function parseEvalOptions(args: string[]): EvalOptions {
  const options: EvalOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--spec") { options.specPath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--template") {
      const value = readValue(args, index, arg);
      if (!isEvalTemplate(value)) throw new CliError(`Unknown eval template: ${value}`, "Use one of: retry-after, duplicate-payment, webhook-signature, no-secret-logs, timeout-recovery, no-production-bypass");
      options.template = value;
      index += 1;
      continue;
    }
    if (arg === "--evidence") { options.evidencePath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--out") { options.outPath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--ci") { options.ci = true; continue; }
    if (arg === "--json") { options.json = true; continue; }
    throw new CliError(`Unknown eval option: ${arg}`, "Supported options: --spec eval.json | --template retry-after, --evidence report.json, --out report.eval.json, --ci, --json");
  }
  if ((options.specPath === undefined) === (options.template === undefined)) throw new CliError("Eval requires exactly one of --spec or --template.", "Use: ghostapi eval --spec eval.json or ghostapi eval --template retry-after");
  return options;
}

function parseWorldCommand(args: string[]): CliCommand {
  const [subcommand, ...rest] = args;
  if (subcommand === "create") return { name: "world-create", options: parseWorldCreateOptions(rest) };
  if (subcommand === "inspect" || subcommand === "reset") {
    const id = rest[0];
    if (!id) throw new CliError(`Missing world id for ${subcommand}.`, `Use: ghostapi world ${subcommand} <world-id> [--json]`);
    if (rest.length === 1) return { name: subcommand === "inspect" ? "world-inspect" : "world-reset", id };
    if (rest.length === 2 && rest[1] === "--json") return { name: subcommand === "inspect" ? "world-inspect" : "world-reset", id, json: true };
    throw new CliError(`Unexpected world ${subcommand} argument: ${rest[1]}`, `Use: ghostapi world ${subcommand} <world-id> [--json]`);
  }
  if (subcommand === "fork") {
    const sourceId = rest[0];
    if (!sourceId) throw new CliError("Missing source world id.", "Use: ghostapi world fork <source-world-id> --id <fork-world-id> [--title title] [--json]");
    return { name: "world-fork", sourceId, options: parseWorldForkOptions(rest.slice(1)) };
  }
  throw new CliError(`Unknown world command: ${subcommand ?? "<missing>"}`, "Use: ghostapi world create|inspect|reset|fork");
}

function parseActionCommand(args: string[]): CliCommand {
  const [subcommand, ...rest] = args;
  if (subcommand === "submit") return { name: "action-submit", options: parseActionSubmitOptions(rest) };
  if (subcommand === "inspect") {
    const actionId = rest[0];
    if (!actionId) throw new CliError("Missing action id.", "Use: ghostapi action inspect <action-id> [--json]");
    if (rest.length === 1) return { name: "action-inspect", actionId };
    if (rest.length === 2 && rest[1] === "--json") return { name: "action-inspect", actionId, json: true };
    throw new CliError(`Unexpected action inspect argument: ${rest[1]}`, "Use: ghostapi action inspect <action-id> [--json]");
  }
  if (subcommand === "execute") return { name: "action-execute", options: parseActionExecuteOptions(rest) };
  throw new CliError(`Unknown action command: ${subcommand ?? "<missing>"}`, "Use: ghostapi action submit|inspect|execute");
}

function parseActionSubmitOptions(args: string[]): ActionSubmitOptions {
  const options: Partial<ActionSubmitOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--action") { options.actionPath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--approval") { options.approvalPath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--policy") { options.policyPath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--json") { options.json = true; continue; }
    throw new CliError(`Unknown action submit option: ${arg}`, "Supported options: --action action.json, --approval approval.json, --policy ghostapi.policy.yaml, --json");
  }
  if (!options.actionPath || !options.approvalPath || !options.policyPath) throw new CliError("Action submit requires --action, --approval, and --policy.", "Use: ghostapi action submit --action action.json --approval approval.json --policy ghostapi.policy.yaml");
  return options as ActionSubmitOptions;
}

function parseActionExecuteOptions(args: string[]): ActionExecuteOptions {
  const options: Partial<ActionExecuteOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--action") { options.actionPath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--policy") { options.policyPath = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--actor") { options.actorId = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--workload") { options.workloadId = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--json") { options.json = true; continue; }
    throw new CliError(`Unknown action execute option: ${arg}`, "Supported options: --action action.json, --policy ghostapi.policy.yaml, --actor actor-id, --workload workload-id, --json");
  }
  if (!options.actionPath || !options.policyPath || !options.actorId || !options.workloadId) throw new CliError("Action execute requires --action, --policy, --actor, and --workload.", "Use: ghostapi action execute --action action.json --policy ghostapi.policy.yaml --actor agent-id --workload workload-id");
  return options as ActionExecuteOptions;
}

function parseTelemetryCommand(args: string[]): CliCommand {
  const [action, ...rest] = args;
  if (action !== "status" && action !== "enable" && action !== "disable" && action !== "export") {
    throw new CliError(`Unknown telemetry command: ${action ?? "<missing>"}`, "Use: ghostapi telemetry status|enable|disable|export [--json]");
  }
  if (rest.length === 0) return { name: "telemetry", action };
  if (rest.length === 1 && rest[0] === "--json") return { name: "telemetry", action, json: true };
  throw new CliError(`Unexpected telemetry argument: ${rest[0]}`, "Use: ghostapi telemetry status|enable|disable|export [--json]");
}

function parseWorldCreateOptions(args: string[]): WorldCreateOptions {
  const options: Partial<WorldCreateOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--id") { options.id = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--seed") { options.seed = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--title") { options.title = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--json") { options.json = true; continue; }
    throw new CliError(`Unknown world create option: ${arg}`, "Supported options: --id <world-id>, --seed <seed>, --title <title>, --json");
  }
  if (!options.id || !options.seed) throw new CliError("World create requires --id and --seed.", "Use: ghostapi world create --id demo --seed stable-seed [--title title]");
  return options as WorldCreateOptions;
}

function parseWorldForkOptions(args: string[]): WorldForkOptions {
  const options: Partial<WorldForkOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--id") { options.id = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--title") { options.title = readValue(args, index, arg); index += 1; continue; }
    if (arg === "--json") { options.json = true; continue; }
    throw new CliError(`Unknown world fork option: ${arg}`, "Supported options: --id <fork-world-id>, --title <title>, --json");
  }
  if (!options.id) throw new CliError("World fork requires --id.", "Use: ghostapi world fork <source-world-id> --id <fork-world-id>");
  return options as WorldForkOptions;
}

function isEvalTemplate(value: string): value is NonNullable<EvalOptions["template"]> {
  return value === "retry-after" || value === "duplicate-payment" || value === "webhook-signature" || value === "no-secret-logs" || value === "timeout-recovery" || value === "no-production-bypass";
}

function parsePolicyExplainInput(args: string[]): PolicyExplainInput {
  const [kind, value, ...rest] = args;
  if (kind === "network") {
    if (!value) throw new CliError("Missing network host.", "Use: ghostapi policy explain network api.stripe.com [--provider stripe]");
    if (rest.length === 0) return { type: "network", host: value };
    if (rest.length === 2 && rest[0] === "--provider" && rest[1]) return { type: "network", host: value, provider: rest[1] };
    throw new CliError("Invalid network explain options.", "Use: ghostapi policy explain network api.stripe.com [--provider stripe]");
  }
  if (kind === "credential") {
    if (!value || rest.length > 0) throw new CliError("Credential explain requires exactly one value.", "Use: ghostapi policy explain credential sk_live_example");
    return { type: "credential", value };
  }
  if (kind === "enforcement") {
    if ((value !== "linux-network-namespace" && value !== "proxy-guidance") || rest.length > 0) throw new CliError("Invalid enforcement mode.", "Use: ghostapi policy explain enforcement linux-network-namespace|proxy-guidance");
    return { type: "enforcement", mode: value };
  }
  if (kind === "report") {
    const forbiddenCredentialMatches = Number(rest[0]);
    const productionEgressAttempts = Number(value);
    const breakingContractChanges = rest.length === 2 ? Number(rest[1]) : undefined;
    if ((rest.length !== 1 && rest.length !== 2) || !Number.isInteger(productionEgressAttempts) || productionEgressAttempts < 0 || !Number.isInteger(forbiddenCredentialMatches) || forbiddenCredentialMatches < 0 || (breakingContractChanges !== undefined && (!Number.isInteger(breakingContractChanges) || breakingContractChanges < 0))) {
      throw new CliError("Report explain requires two or three non-negative integer counts.", "Use: ghostapi policy explain report 0 0 [0]");
    }
    return { type: "report", productionEgressAttempts, forbiddenCredentialMatches, ...(breakingContractChanges === undefined ? {} : { breakingContractChanges }) };
  }
  if (args.length !== 1) throw new CliError("Scenario explain accepts one scenario id.", "Use: ghostapi policy explain stripe.card_declined");
  return { type: "scenario", scenarioId: kind!, completedScenarioIds: [] };
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`Missing value for ${flag}.`, `Use ${flag} <value>.`);
  }
  return value;
}

function isPiiRuleSet(value: string): boolean {
  if (value === "none") return true;
  const selected = value.split(",");
  return selected.length > 0 && selected.length === new Set(selected).size && selected.every((entry) => entry === "emails" || entry === "phones" || entry === "addresses");
}

export function parsePort(value: string, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`Invalid ${label}: ${value}`, "Port must be an integer between 1 and 65535.");
  }
  return port;
}

function isClearTarget(value: string | undefined): value is ClearTarget {
  return value === "cache" || value === "state" || value === "events" || value === "all";
}
