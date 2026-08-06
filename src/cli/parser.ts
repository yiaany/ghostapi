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
  command: string[];
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
  if (options.json && !options.egress) throw new CliError("--json requires --egress.", "Use: ghostapi doctor --egress --json");
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
    throw new CliError(`Unknown run option: ${arg}`, "Supported options: --port 8080, --allow-host localhost");
  }

  return options;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`Missing value for ${flag}.`, `Use ${flag} <value>.`);
  }
  return value;
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
