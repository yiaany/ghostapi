import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setApiBehavior } from "../behavior/behaviorStore.js";
import type { ProxyEvent } from "../server/eventsStore.js";
import { getDataPaths } from "../config/dataPaths.js";
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";
import { sanitizeSecrets } from "../security/secrets.js";
import { getProviderScenarios } from "../providers/registry.js";
import { sanitizeResponseHeaders } from "../security/headerSanitizer.js";

export const MAX_CUSTOM_SCENARIOS = 200;
const MAX_SCENARIO_BYTES = 512 * 1024;
const MAX_SCENARIO_STORE_BYTES = 20 * 1024 * 1024;

export type ScenarioStep = {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export type ScenarioPreset = {
  id: string;
  title: string;
  provider: string;
  description: string;
  steps: ScenarioStep[];
};

export type ScenarioReplayResult = {
  scenario: ScenarioPreset;
  applied: Array<{ method: string; path: string; status: number }>;
};

const SCENARIOS: ScenarioPreset[] = [
  {
    id: "stripe-customer-create",
    title: "Stripe customer create",
    provider: "stripe",
    description: "Returns a stable customer object for local onboarding and billing flows.",
    steps: [
      {
        name: "Create customer",
        method: "POST",
        path: "/v1/customers",
        status: 200,
        body: { id: "cus_ghostapi_123", object: "customer", email: "founder@example.com", livemode: false, metadata: { scenario: "stripe-customer-create" } }
      }
    ]
  },
  {
    id: "stripe-payment-intent-fail",
    title: "Payment intent fail",
    provider: "stripe",
    description: "Forces a card-decline shaped Stripe error so agents must implement failure handling.",
    steps: [
      {
        name: "Payment intent card declined",
        method: "POST",
        path: "/v1/payment_intents",
        status: 402,
        body: { error: { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined.", param: "payment_method" } }
      }
    ]
  },
  ...getProviderScenarios(),
  {
    id: "github-issue-create",
    title: "GitHub issue create",
    provider: "github",
    description: "Returns a deterministic issue payload for GitHub automation tests.",
    steps: [
      {
        name: "Create issue",
        method: "POST",
        path: "/repos/ghostapi/demo/issues",
        status: 201,
        body: { id: 10001, number: 42, title: "GhostAPI local issue", state: "open", html_url: "https://github.local/ghostapi/demo/issues/42" }
      }
    ]
  }
];

export async function listScenarioPresets(): Promise<ScenarioPreset[]> {
  return [...structuredClone(SCENARIOS), ...(await listCustomScenarios())];
}

export async function getScenarioPreset(id: string): Promise<ScenarioPreset | null> {
  const builtIn = SCENARIOS.find((scenario) => scenario.id === id);
  if (builtIn !== undefined) return structuredClone(builtIn);
  return await readCustomScenario(id);
}

export async function replayScenario(id: string): Promise<ScenarioReplayResult> {
  const scenario = await getScenarioPreset(id);
  if (scenario === null) throw new Error(`Unknown scenario: ${id}`);

  const applied = [];
  for (const step of scenario.steps) {
    await setApiBehavior({ method: step.method, path: step.path, status: step.status, body: step.body, headers: step.headers });
    applied.push({ method: step.method, path: step.path, status: step.status });
  }

  return { scenario, applied };
}

export async function exportScenario(id: string): Promise<ScenarioPreset> {
  const scenario = await getScenarioPreset(id);
  if (scenario === null) throw new Error(`Unknown scenario: ${id}`);
  return scenario;
}

export async function shareScenario(id: string): Promise<{ scenario: ScenarioPreset; shareText: string }> {
  const scenario = await exportScenario(id);
  const encoded = Buffer.from(JSON.stringify(scenario), "utf8").toString("base64url");
  return {
    scenario,
    shareText: `ghostapi://scenario/${encoded}`
  };
}

export async function importScenario(input: unknown): Promise<ScenarioPreset> {
  const scenario = normalizeScenario(input);
  await writeScenario(scenario);
  return scenario;
}

export async function saveEventsAsScenario(events: ProxyEvent[], input: { title?: string; id?: string } = {}): Promise<ScenarioPreset> {
  const title = input.title?.trim() || `Traffic scenario ${new Date().toISOString()}`;
  const id = input.id?.trim() || slugify(title);
  const scenario = normalizeScenario({
    id,
    title,
    provider: "traffic",
    description: "Saved from recent GhostAPI traffic.",
    steps: events.filter((event) => event.source !== "fault").slice(-20).map((event, index) => ({
      name: `${index + 1}. ${event.method} ${event.path}`,
      method: event.method,
      path: event.path,
      status: event.statusCode,
      body: event.response
    }))
  });
  await writeScenario(scenario);
  return scenario;
}

async function listCustomScenarios(): Promise<ScenarioPreset[]> {
  try {
    const scenariosDir = getDataPaths().scenarios;
    const entries = await readdir(scenariosDir, { withFileTypes: true });
    const scenarios = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        scenarios.push(normalizeScenario(JSON.parse(await readFile(join(scenariosDir, entry.name), "utf8"))));
      }
    }
    return scenarios;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readCustomScenario(id: string): Promise<ScenarioPreset | null> {
  try {
    return normalizeScenario(JSON.parse(await readFile(join(getDataPaths().scenarios, `${slugify(id)}.json`), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeScenario(scenario: ScenarioPreset): Promise<void> {
  const sanitized = sanitizeSecrets(scenario);
  const bytes = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
  if (bytes > MAX_SCENARIO_BYTES) throw new Error("Scenario exceeds its size limit.");
  const directory = getDataPaths().scenarios;
  await ensurePrivateDirectory(directory);
  await withFileLock(join(directory, ".quota"), async () => {
    const files = await readdir(directory, { withFileTypes: true });
    const existing = await Promise.all(files.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== `${scenario.id}.json`).map(async (entry) => ({ name: entry.name, size: (await stat(join(directory, entry.name))).size })));
    if (existing.length >= MAX_CUSTOM_SCENARIOS || existing.reduce((total, entry) => total + entry.size, bytes) > MAX_SCENARIO_STORE_BYTES) throw new Error("Custom scenario persistence quota was reached.");
    await atomicWriteJson(join(directory, `${scenario.id}.json`), sanitized);
  }, { lockTimeoutMs: 60_000 });
}

function normalizeScenario(input: unknown): ScenarioPreset {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Scenario must be an object.");
  const record = input as Record<string, unknown>;
  if (typeof record.title !== "string" || record.title.trim() === "" || record.title.length > 200 || /[\r\n\0]/.test(record.title)) throw new Error("Scenario title is invalid.");
  if (!Array.isArray(record.steps) || record.steps.length === 0 || record.steps.length > 100) throw new Error("Scenario steps must contain 1-100 entries.");
  const id = typeof record.id === "string" && record.id.trim() !== "" ? slugify(record.id) : slugify(record.title);
  return sanitizeSecrets({
    id,
    title: record.title.trim(),
    provider: typeof record.provider === "string" ? record.provider : "custom",
    description: typeof record.description === "string" ? record.description : "Custom GhostAPI scenario.",
    steps: record.steps.map(normalizeStep)
  }) as ScenarioPreset;
}

function normalizeStep(input: unknown): ScenarioStep {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Scenario step must be an object.");
  const record = input as Record<string, unknown>;
  const method = String(record.method ?? "GET").toUpperCase();
  if (!isScenarioMethod(method)) throw new Error("Scenario step method is invalid.");
  const path = String(record.path ?? "");
  if (!path.startsWith("/") || path.length > 2048 || /[\r\n\0]/.test(path)) throw new Error("Scenario step path is invalid.");
  const status = Number(record.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("Scenario step status must be 100-599.");
  const name = typeof record.name === "string" ? record.name : `${method} ${path}`;
  if (name.length === 0 || name.length > 200 || /[\r\n\0]/.test(name)) throw new Error("Scenario step name is invalid.");
  return { name, method, path, status, body: record.body ?? {}, headers: readHeaders(record.headers) };
}

function readHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, headerValue]) => [key, String(headerValue)]));
  const safe = sanitizeResponseHeaders(raw) as Record<string, string>;
  if (Object.keys(raw).length !== Object.keys(safe).length) throw new Error("Scenario response headers contain an unsafe or unsupported header.");
  return safe;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isScenarioMethod(value: string): value is ScenarioStep["method"] {
  return value === "GET" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE";
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "custom-scenario";
}
