import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { isJsonObject } from "../utils/json.js";

export type GhostApiFileConfig = {
  host?: string;
  port?: number;
  model?: string;
  offline?: boolean;
  https?: boolean;
};

export const GHOSTAPI_DIR = ".ghostapi";
export const CONFIG_PATH = ".ghostapi/config.json";

export function readLocalConfigSync(): GhostApiFileConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
  return sanitizeConfig(parsed);
}

export async function readLocalConfig(): Promise<GhostApiFileConfig> {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as unknown;
    return sanitizeConfig(parsed);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeLocalConfig(config: GhostApiFileConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(sanitizeConfig(config), null, 2) + "\n", "utf8");
}

export async function initializeLocalConfig(): Promise<{ created: boolean; config: GhostApiFileConfig }> {
  if (existsSync(CONFIG_PATH)) {
    return { created: false, config: await readLocalConfig() };
  }
  const config: GhostApiFileConfig = {
    host: "127.0.0.1",
    port: 8080,
    model: "gpt-4o-mini",
    offline: false,
    https: false
  };
  await writeLocalConfig(config);
  return { created: true, config };
}

function sanitizeConfig(value: unknown): GhostApiFileConfig {
  if (!isJsonObject(value)) return {};
  const config: GhostApiFileConfig = {};
  if (typeof value.host === "string" && value.host.trim() !== "") config.host = value.host;
  if (typeof value.model === "string" && value.model.trim() !== "") config.model = value.model;
  if (typeof value.port === "number" && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535) config.port = value.port;
  if (typeof value.offline === "boolean") config.offline = value.offline;
  if (typeof value.https === "boolean") config.https = value.https;
  return config;
}
