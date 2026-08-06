import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { isJsonObject } from "../utils/json.js";
import { getDataPaths } from "./dataPaths.js";
import { atomicWriteJson, withFileLock } from "../storage/fileStore.js";

export type GhostApiFileConfig = {
  host?: string;
  port?: number;
  model?: string;
  offline?: boolean;
  https?: boolean;
  allowExternalLlm?: boolean;
};

export function readLocalConfigSync(): GhostApiFileConfig {
  const configPath = getDataPaths().config;
  if (!existsSync(configPath)) return {};
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  return sanitizeConfig(parsed);
}

export async function readLocalConfig(): Promise<GhostApiFileConfig> {
  const configPath = getDataPaths().config;
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    return sanitizeConfig(parsed);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeLocalConfig(config: GhostApiFileConfig): Promise<void> {
  const configPath = getDataPaths().config;
  await withFileLock(configPath, () => atomicWriteJson(configPath, sanitizeConfig(config)));
}

export async function initializeLocalConfig(): Promise<{ created: boolean; config: GhostApiFileConfig }> {
  const configPath = getDataPaths().config;
  return withFileLock(configPath, async () => {
    if (existsSync(configPath)) return { created: false, config: await readLocalConfig() };
    const config: GhostApiFileConfig = {
      host: "127.0.0.1",
      port: 8080,
      model: "gpt-4o-mini",
      offline: false,
      https: false,
      allowExternalLlm: false
    };
    await atomicWriteJson(configPath, config);
    return { created: true, config };
  });
}

function sanitizeConfig(value: unknown): GhostApiFileConfig {
  if (!isJsonObject(value)) return {};
  const config: GhostApiFileConfig = {};
  if (typeof value.host === "string" && value.host.trim() !== "") config.host = value.host;
  if (typeof value.model === "string" && value.model.trim() !== "") config.model = value.model;
  if (typeof value.port === "number" && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535) config.port = value.port;
  if (typeof value.offline === "boolean") config.offline = value.offline;
  if (typeof value.https === "boolean") config.https = value.https;
  if (typeof value.allowExternalLlm === "boolean") config.allowExternalLlm = value.allowExternalLlm;
  return config;
}
