import { isAbsolute, relative, resolve, sep } from "node:path";

export type DataPaths = {
  root: string;
  config: string;
  state: string;
  behaviors: string;
  cache: string;
  events: string;
  reports: string;
  scenarios: string;
  contracts: string;
  worlds: string;
  actions: string;
  credentialBroker: string;
  teamControlPlane: string;
  faultLab: string;
  productTelemetry: string;
};

export function getDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GHOSTAPI_DATA_DIR?.trim();
  return resolve(configured && configured !== "" ? configured : ".ghostapi");
}

export function resolveDataPath(...segments: string[]): string {
  const root = getDataDir();
  const target = resolve(root, ...segments);
  const relativePath = relative(root, target);

  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("GhostAPI data path must stay inside GHOSTAPI_DATA_DIR.");
  }

  return target;
}

export function getDataPaths(): DataPaths {
  return {
    root: getDataDir(),
    config: resolveDataPath("config.json"),
    state: resolveDataPath("state.json"),
    behaviors: resolveDataPath("behaviors.json"),
    cache: resolveDataPath("cache"),
    events: resolveDataPath("events.jsonl"),
    reports: resolveDataPath("reports"),
    scenarios: resolveDataPath("scenarios"),
    contracts: resolveDataPath("contracts"),
    worlds: resolveDataPath("worlds"),
    actions: resolveDataPath("actions"),
    credentialBroker: resolveDataPath("credential-broker.json"),
    teamControlPlane: resolveDataPath("team-control-plane.json"),
    faultLab: resolveDataPath("fault-lab.json"),
    productTelemetry: resolveDataPath("product-telemetry.json")
  };
}
