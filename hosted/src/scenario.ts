import { stableJson } from "./crypto.js";

const PATH_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const MAX_DEFINITION_BYTES = 256 * 1024;
const MAX_PATHS = 100;

export type ScenarioDefinition = {
  when?: Record<string, unknown>;
  assertions?: Array<{ path: string; equals?: unknown; exists?: true }>;
};

export class ScenarioDefinitionError extends Error {
  constructor() {
    super("invalid_scenario_definition");
  }
}

export function validateScenarioDefinition(
  value: unknown,
): asserts value is ScenarioDefinition {
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => key !== "when" && key !== "assertions")
  )
    throw new ScenarioDefinitionError();
  const when = value.when ?? {};
  if (!isObject(when) || Object.keys(when).length > MAX_PATHS)
    throw new ScenarioDefinitionError();
  for (const [path, expected] of Object.entries(when)) {
    validatePath(path);
    validateJson(expected, 0);
  }

  const assertions = value.assertions ?? [];
  if (!Array.isArray(assertions) || assertions.length > MAX_PATHS)
    throw new ScenarioDefinitionError();
  for (const assertion of assertions) {
    if (
      !isObject(assertion) ||
      Object.keys(assertion).some(
        (key) => !["path", "equals", "exists"].includes(key),
      )
    )
      throw new ScenarioDefinitionError();
    if (typeof assertion.path !== "string") throw new ScenarioDefinitionError();
    validatePath(assertion.path);
    const hasEquals = Object.hasOwn(assertion, "equals");
    const hasExists = assertion.exists === true;
    if (hasEquals === hasExists) throw new ScenarioDefinitionError();
    if (hasEquals) validateJson(assertion.equals, 0);
  }

  if (Buffer.byteLength(stableJson(value), "utf8") > MAX_DEFINITION_BYTES)
    throw new ScenarioDefinitionError();
}

export function validatePath(path: string): void {
  if (path.length < 1 || path.length > 256 || !PATH_PATTERN.test(path))
    throw new ScenarioDefinitionError();
}

function validateJson(value: unknown, depth: number): void {
  if (depth > 8) throw new ScenarioDefinitionError();
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (typeof value === "string") {
    if (value.length > 64 * 1024) throw new ScenarioDefinitionError();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new ScenarioDefinitionError();
    for (const entry of value) validateJson(entry, depth + 1);
    return;
  }
  if (!isObject(value) || Object.keys(value).length > 1_000)
    throw new ScenarioDefinitionError();
  for (const entry of Object.values(value)) validateJson(entry, depth + 1);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
