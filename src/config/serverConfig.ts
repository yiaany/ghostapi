import { readLocalConfigSync, type GhostApiFileConfig } from "./localConfig.js";

export type ServerConfig = {
  host: string;
  port: number;
  model: string;
  offline?: boolean;
  https?: boolean;
  allowExternalLlm?: boolean;
  apiKey?: string;
  authToken?: string;
};

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8080;
export const DEFAULT_MODEL = "gpt-4o-mini";

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv,
  overrides: GhostApiFileConfig = {},
): ServerConfig {
  const localConfig = readLocalConfigSync();
  const offline = parseBoolean(
    overrides.offline,
    parseBooleanEnv(env.GHOSTAPI_OFFLINE, localConfig.offline ?? false),
  );
  const allowExternalLlm =
    !offline &&
    parseBoolean(
      overrides.allowExternalLlm,
      parseBooleanEnv(
        env.GHOSTAPI_ALLOW_EXTERNAL_LLM,
        localConfig.allowExternalLlm ?? false,
      ),
    );

  return {
    host:
      overrides.host ?? env.GHOSTAPI_HOST ?? localConfig.host ?? DEFAULT_HOST,
    port: overrides.port ?? parsePort(env.GHOSTAPI_PORT, localConfig.port),
    model:
      overrides.model ??
      parseModel(env.GHOSTAPI_MODEL, args, localConfig.model),
    offline,
    https: parseBoolean(
      overrides.https,
      parseBooleanEnv(env.GHOSTAPI_HTTPS, localConfig.https ?? false),
    ),
    allowExternalLlm,
    apiKey: allowExternalLlm
      ? readNonEmpty(env.GHOSTAPI_LLM_API_KEY)
      : undefined,
    authToken: readNonEmpty(env.GHOSTAPI_AUTH_TOKEN),
  };
}

function parseModel(
  envModel: string | undefined,
  args: string[],
  configModel: string | undefined,
): string {
  const modelIndex = args.indexOf("--model");
  if (modelIndex !== -1 && args[modelIndex + 1]) {
    return args[modelIndex + 1]!;
  }
  if (envModel && envModel.trim() !== "") return envModel;
  return configModel && configModel.trim() !== "" ? configModel : DEFAULT_MODEL;
}

function parsePort(
  value: string | undefined,
  configPort: number | undefined,
): number {
  if (value === undefined || value.trim() === "") {
    return configPort ?? DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid GHOSTAPI_PORT: ${value}`);
  }

  return port;
}

function parseBoolean(value: boolean | undefined, fallback: boolean): boolean {
  return value ?? fallback;
}

function parseBooleanEnv(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return (
    value === "1" ||
    value.toLowerCase() === "true" ||
    value.toLowerCase() === "yes"
  );
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
