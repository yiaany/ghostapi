import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseAllDocuments } from "yaml";
import type { EnforcementMode, GhostApiPolicy, NetworkRule, PolicyDecision, PolicyEvent } from "./types.js";

const MAX_POLICY_BYTES = 128 * 1024;
const MAX_LIST_ITEMS = 200;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ENFORCEMENT_MODES = new Set<EnforcementMode>(["linux-network-namespace", "proxy-guidance"]);

export class PolicyValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "PolicyValidationError";
    this.path = path;
  }
}

export type LoadedPolicy = {
  policy: GhostApiPolicy;
  hash: string;
  path: string;
};

export async function loadPolicyFile(filePath = "ghostapi.policy.yaml", projectRoot = process.cwd(), required = false): Promise<LoadedPolicy | null> {
  const { root, path: resolvedPath } = await resolvePolicyPath(filePath, projectRoot);
  try {
    const info = await lstat(resolvedPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new PolicyValidationError("policy", "must be a regular non-symlink file.");
  } catch (error) {
    if (isErrorCode(error, "ENOENT") && !required) return null;
    if (isErrorCode(error, "ENOENT")) throw new PolicyValidationError("policy", `file not found: ${filePath}.`);
    throw error;
  }

  const realPolicyPath = await realpath(resolvedPath);
  assertPathWithinRoot(root, realPolicyPath);
  const source = await readFile(realPolicyPath, "utf8");
  const policy = parsePolicyYaml(source);
  return { policy, hash: createHash("sha256").update(source, "utf8").digest("hex"), path: realPolicyPath };
}

export function parsePolicyYaml(source: string): GhostApiPolicy {
  if (Buffer.byteLength(source, "utf8") > MAX_POLICY_BYTES) {
    throw new PolicyValidationError("policy", `exceeds the ${MAX_POLICY_BYTES} byte limit.`);
  }
  if (/(?:^|\s)[*&][A-Za-z0-9_-]+/.test(source)) {
    throw new PolicyValidationError("policy", "YAML anchors and aliases are not allowed.");
  }

  const documents = parseAllDocuments(source, { uniqueKeys: true, merge: false, prettyErrors: false });
  if (documents.length !== 1) throw new PolicyValidationError("policy", "must contain exactly one YAML document.");
  const document = documents[0]!;
  if (document.errors.length > 0) throw new PolicyValidationError("policy", document.errors[0]!.message.replace(/\n.*/s, ""));
  if (document.warnings.length > 0) throw new PolicyValidationError("policy", document.warnings[0]!.message.replace(/\n.*/s, ""));

  const raw = document.toJS({ maxAliasCount: 0 });
  rejectInterpolation(raw, "policy");
  const policy = parsePolicy(raw);
  return policy;
}

export function evaluatePolicy(policy: GhostApiPolicy, event: PolicyEvent): PolicyDecision {
  switch (event.type) {
    case "network":
      return evaluateNetwork(policy, event.host, event.provider);
    case "credential":
      return evaluateCredential(policy, event.value);
    case "scenario":
      return evaluateScenario(policy, event.scenarioId, event.completedScenarioIds);
    case "enforcement":
      return policy.enforcement.allowedModes.includes(event.mode)
        ? allow(`Enforcement mode ${event.mode} is allowed.`, [`enforcement.allowedModes contains ${event.mode}`])
        : deny(`Enforcement mode ${event.mode} is forbidden.`, [`enforcement.allowedModes does not contain ${event.mode}`]);
    case "report":
      return evaluateReport(policy, event);
  }
}

export function formatPolicyDecision(decision: PolicyDecision): string {
  return [`Decision: ${decision.allowed ? "ALLOW" : "DENY"}`, `Reason: ${decision.reason}`, "Trace:", ...decision.trace.map((item) => `  - ${item}`)].join("\n");
}

async function resolvePolicyPath(filePath: string, projectRoot: string): Promise<{ root: string; path: string }> {
  if (isAbsolute(filePath)) throw new PolicyValidationError("policy", "must be a relative path inside the project root.");
  const root = await realpath(projectRoot);
  const target = resolve(root, filePath);
  assertPathWithinRoot(root, target);
  return { root, path: target };
}

function assertPathWithinRoot(root: string, target: string): void {
  const relativePath = relative(root, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new PolicyValidationError("policy", "path traversal outside the project root is not allowed.");
  }
}

function parsePolicy(value: unknown): GhostApiPolicy {
  const record = recordAt(value, "policy");
  assertKeys(record, "policy", ["version", "network", "credentials", "requiredScenarios", "enforcement", "reports"]);
  if (record.version !== 1) throw new PolicyValidationError("policy.version", "must be the supported schema version 1.");

  const networkRecord = recordAt(record.network, "policy.network");
  assertKeys(networkRecord, "policy.network", ["default", "allow", "deny", "productionHosts"]);
  const defaultAction = enumAt(networkRecord.default, "policy.network.default", ["allow", "deny"] as const);

  const credentialsRecord = recordAt(record.credentials, "policy.credentials");
  assertKeys(credentialsRecord, "policy.credentials", ["forbid"]);
  const enforcementRecord = recordAt(record.enforcement, "policy.enforcement");
  assertKeys(enforcementRecord, "policy.enforcement", ["allowedModes"]);
  const reportsRecord = recordAt(record.reports, "policy.reports");
  assertKeys(reportsRecord, "policy.reports", ["maxProductionEgressAttempts", "maxForbiddenCredentialMatches", "maxBreakingContractChanges"]);

  return {
    version: 1,
    network: {
      default: defaultAction,
      allow: rulesAt(networkRecord.allow ?? [], "policy.network.allow"),
      deny: rulesAt(networkRecord.deny ?? [], "policy.network.deny"),
      productionHosts: stringsAt(networkRecord.productionHosts ?? [], "policy.network.productionHosts", normalizeHost)
    },
    credentials: { forbid: stringsAt(credentialsRecord.forbid ?? [], "policy.credentials.forbid", validateCredentialGlob) },
    requiredScenarios: stringsAt(record.requiredScenarios ?? [], "policy.requiredScenarios", validateScenarioId),
    enforcement: { allowedModes: arrayAt(enforcementRecord.allowedModes ?? [], "policy.enforcement.allowedModes").map((entry, index) => validateEnforcementMode(entry, `policy.enforcement.allowedModes[${index}]`)) },
    reports: {
      maxProductionEgressAttempts: nonNegativeIntegerAt(reportsRecord.maxProductionEgressAttempts, "policy.reports.maxProductionEgressAttempts"),
      maxForbiddenCredentialMatches: nonNegativeIntegerAt(reportsRecord.maxForbiddenCredentialMatches, "policy.reports.maxForbiddenCredentialMatches"),
      maxBreakingContractChanges: nonNegativeIntegerAt(reportsRecord.maxBreakingContractChanges ?? 0, "policy.reports.maxBreakingContractChanges")
    }
  };
}

function evaluateNetwork(policy: GhostApiPolicy, hostValue: string, provider: string | undefined): PolicyDecision {
  const host = normalizeHost(hostValue, "event.host");
  const trace = [`network host: ${host}`, `production classification: ${matchesAnyHost(policy.network.productionHosts, host) ? "production" : "non-production"}`];
  const deniedRule = policy.network.deny.find((rule) => ruleMatches(rule, host, provider));
  if (deniedRule !== undefined) return deny("A matching deny rule takes precedence over every allow rule.", [...trace, `matched network.deny ${describeRule(deniedRule)}`]);
  const allowedRule = policy.network.allow.find((rule) => ruleMatches(rule, host, provider));
  if (allowedRule !== undefined) return allow("A matching allow rule permits the network event.", [...trace, `matched network.allow ${describeRule(allowedRule)}`]);
  return policy.network.default === "allow"
    ? allow("No network rule matched; network.default is allow.", [...trace, "no matching allow or deny rule", "network.default: allow"])
    : deny("No network rule matched; network.default is deny.", [...trace, "no matching allow or deny rule", "network.default: deny"]);
}

function evaluateCredential(policy: GhostApiPolicy, value: string): PolicyDecision {
  const match = policy.credentials.forbid.find((pattern) => globMatches(pattern, value));
  return match === undefined
    ? allow("No forbidden credential pattern matched.", ["credential input was checked without interpolation", "no policy.credentials.forbid pattern matched"])
    : deny("A forbidden credential pattern matched.", [`matched policy.credentials.forbid pattern ${match}`]);
}

function evaluateScenario(policy: GhostApiPolicy, scenarioId: string, completed: readonly string[]): PolicyDecision {
  if (!policy.requiredScenarios.includes(scenarioId)) return allow("Scenario is not required by this policy.", [`${scenarioId} is not in policy.requiredScenarios`]);
  return completed.includes(scenarioId)
    ? allow("Required scenario is complete.", [`${scenarioId} is required and present in completed scenarios`])
    : deny("Required scenario has not completed.", [`${scenarioId} is required but absent from completed scenarios`]);
}

function evaluateReport(policy: GhostApiPolicy, event: Extract<PolicyEvent, { type: "report" }>): PolicyDecision {
  const trace = [
    `production egress attempts: ${event.productionEgressAttempts} <= ${policy.reports.maxProductionEgressAttempts}`,
    `forbidden credential matches: ${event.forbiddenCredentialMatches} <= ${policy.reports.maxForbiddenCredentialMatches}`,
    `breaking contract changes: ${event.breakingContractChanges ?? 0} <= ${policy.reports.maxBreakingContractChanges}`
  ];
  return event.productionEgressAttempts <= policy.reports.maxProductionEgressAttempts && event.forbiddenCredentialMatches <= policy.reports.maxForbiddenCredentialMatches && (event.breakingContractChanges ?? 0) <= policy.reports.maxBreakingContractChanges
    ? allow("Report thresholds are satisfied.", trace)
    : deny("A report threshold is exceeded.", trace);
}

function rulesAt(value: unknown, path: string): NetworkRule[] {
  const list = arrayAt(value, path);
  return list.map((entry, index) => {
    const rulePath = `${path}[${index}]`;
    const record = recordAt(entry, rulePath);
    assertKeys(record, rulePath, ["host", "provider"]);
    const hasHost = record.host !== undefined;
    const hasProvider = record.provider !== undefined;
    if (hasHost === hasProvider) throw new PolicyValidationError(rulePath, "must contain exactly one of host or provider.");
    return hasHost ? { host: normalizeHost(record.host, `${rulePath}.host`) } : { provider: providerAt(record.provider, `${rulePath}.provider`) };
  });
}

function stringsAt(value: unknown, path: string, validate: (value: unknown, path: string) => string): string[] {
  return arrayAt(value, path).map((entry, index) => validate(entry, `${path}[${index}]`));
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new PolicyValidationError(path, "must be an array.");
  if (value.length > MAX_LIST_ITEMS) throw new PolicyValidationError(path, `must contain at most ${MAX_LIST_ITEMS} items.`);
  return value;
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PolicyValidationError(path, "must be an object.");
  return value as Record<string, unknown>;
}

function assertKeys(record: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new PolicyValidationError(`${path}.${key}`, "is not a supported field.");
  }
}

function enumAt<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new PolicyValidationError(path, `must be one of: ${allowed.join(", ")}.`);
  return value as T;
}

function nonNegativeIntegerAt(value: unknown, path: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) throw new PolicyValidationError(path, "must be a non-negative integer.");
  return value;
}

function normalizeHost(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) throw new PolicyValidationError(path, "must be a non-empty host up to 253 characters.");
  const host = value.toLowerCase();
  if (host.includes("${") || !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^(?:\*\.)?(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|::1)$/.test(host)) {
    throw new PolicyValidationError(path, "must be a lowercase DNS host, loopback address, or leading-wildcard DNS suffix.");
  }
  return host;
}

function providerAt(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new PolicyValidationError(path, "must be a lowercase provider identifier.");
  return value;
}

function validateCredentialGlob(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) throw new PolicyValidationError(path, "must be a glob string between 1 and 128 characters.");
  if (value.includes("${") || /[\r\n]/.test(value)) throw new PolicyValidationError(path, "must not contain interpolation or newlines.");
  return value;
}

function validateScenarioId(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new PolicyValidationError(path, "must be a lowercase scenario identifier.");
  return value;
}

function validateEnforcementMode(value: unknown, path: string): EnforcementMode {
  return enumAt(value, path, [...ENFORCEMENT_MODES]);
}

function rejectInterpolation(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (value.includes("${")) throw new PolicyValidationError(path, "environment interpolation is not supported.");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectInterpolation(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) rejectInterpolation(entry, `${path}.${key}`);
  }
}

function ruleMatches(rule: NetworkRule, host: string, provider: string | undefined): boolean {
  return rule.host !== undefined ? hostMatches(rule.host, host) : rule.provider === provider?.toLowerCase();
}

function matchesAnyHost(patterns: readonly string[], host: string): boolean {
  return patterns.some((pattern) => hostMatches(pattern, host));
}

function hostMatches(pattern: string, host: string): boolean {
  return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2) : pattern === host;
}

function describeRule(rule: NetworkRule): string {
  return rule.host !== undefined ? `host:${rule.host}` : `provider:${rule.provider}`;
}

function globMatches(pattern: string, value: string): boolean {
  const states = new Array<boolean>(value.length + 1).fill(false);
  states[0] = true;
  for (const character of pattern) {
    if (character === "*") {
      for (let index = 1; index < states.length; index += 1) states[index] = states[index] || states[index - 1]!;
      continue;
    }
    for (let index = value.length; index >= 1; index -= 1) states[index] = states[index - 1]! && value[index - 1] === character;
    states[0] = false;
  }
  return states[value.length]!;
}

function allow(reason: string, trace: string[]): PolicyDecision {
  return { allowed: true, reason, trace };
}

function deny(reason: string, trace: string[]): PolicyDecision {
  return { allowed: false, reason, trace };
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
