import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
  join,
} from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { atomicWriteJson } from "../storage/fileStore.js";
import {
  isSecretFieldName,
  sanitizeSecretString,
  sanitizeSecrets,
} from "../security/secrets.js";
import { isSafeRelativeLocation } from "../security/headerSanitizer.js";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024;
const MAX_INTERACTIONS = 100;
const MAX_VARIABLES = 200;
const MAX_VALUE_DEPTH = 30;
const MAX_VALUE_KEYS = 200;
const VARIABLE_PATTERN = /\{\{ghostapi\.var\.([a-z][a-z0-9_]*)\}\}/g;
const SENSITIVE_QUERY_KEYS = new Set([
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "token",
  "secret",
  "key",
  "client_secret",
  "password",
  "authorization",
  "cookie",
]);
const SAFE_REQUEST_HEADERS = new Set(["accept", "content-type"]);
const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "retry-after",
  "location",
]);
const METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export type ScenarioBundle = {
  schemaVersion: 1;
  kind: "ghostapi.scenario-bundle";
  metadata: {
    title: string;
    recordedAt: string;
    sandboxHosts: string[];
  };
  sanitization: ScenarioSanitizationSummary;
  variables: Array<{ name: string; value: string }>;
  interactions: ScenarioBundleInteraction[];
};

export type ScenarioBundleInteraction = {
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
};

export type ScenarioSanitizationSummary = {
  categories: string[];
  replacements: number;
  requiresApproval: boolean;
};

export type ScenarioRecordingOptions = {
  title?: string;
  allowedSandboxHosts: string[];
  pii?: Partial<ScenarioPiiRules>;
  recordedAt?: string;
};

export type ScenarioPiiRules = {
  emails: boolean;
  phones: boolean;
  addresses: boolean;
};

export type ScenarioReplayRequest = {
  method: string;
  path: string;
  headers?: Record<string, string | string[]>;
  body?: unknown;
};

export type ScenarioReplayResult = {
  index: number;
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

type RawInteraction = {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
    binary: boolean;
    multipart: boolean;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    binary: boolean;
    multipart: boolean;
  };
};

type SanitizerState = {
  pii: ScenarioPiiRules;
  categories: Set<string>;
  replacements: number;
  variables: Map<string, { name: string; value: string }>;
};

export class ScenarioBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioBundleError";
  }
}

export class ScenarioReplayer {
  private cursor = 0;
  private readonly bindings = new Map<string, string>();

  constructor(private readonly bundle: ScenarioBundle) {}

  replay(request: ScenarioReplayRequest): ScenarioReplayResult {
    const interaction = this.bundle.interactions[this.cursor];
    if (interaction === undefined) {
      throw new ScenarioBundleError(
        `Replay received an unexpected request after interaction ${this.cursor}. The bundle has no remaining interactions.`,
      );
    }

    const actual = normalizeReplayRequest(request);
    const candidateBindings = new Map(this.bindings);
    const mismatches = compareRequest(
      interaction.request,
      actual,
      candidateBindings,
      this.bundle.variables,
    );
    if (mismatches.length > 0) {
      throw new ScenarioBundleError(
        `Replay mismatch at interaction ${this.cursor + 1}: ${mismatches.join("; ")}. Replay is sequence-strict and never searches for an alternative match.`,
      );
    }

    this.bindings.clear();
    for (const [name, value] of candidateBindings)
      this.bindings.set(name, value);
    this.cursor += 1;
    return {
      index: this.cursor,
      status: interaction.response.status,
      headers: resolveHeaders(
        interaction.response.headers,
        this.bundle.variables,
        this.bindings,
      ),
      body: resolveVariables(
        interaction.response.body,
        this.bundle.variables,
        this.bindings,
      ),
    };
  }

  get remaining(): number {
    return this.bundle.interactions.length - this.cursor;
  }
}

export function prepareScenarioRecording(
  input: unknown,
  options: ScenarioRecordingOptions,
): ScenarioBundle {
  if (serializedBytes(input, "Recording input") > MAX_CAPTURE_BYTES)
    throw new ScenarioBundleError(
      `Recording input exceeds ${MAX_CAPTURE_BYTES} bytes.`,
    );
  const allowedHosts = normalizeAllowedSandboxHosts(
    options.allowedSandboxHosts,
  );
  const rawInteractions = parseCapture(input);
  if (rawInteractions.length === 0)
    throw new ScenarioBundleError(
      "Recording input does not contain any interactions.",
    );
  if (rawInteractions.length > MAX_INTERACTIONS)
    throw new ScenarioBundleError(
      `Recording input exceeds ${MAX_INTERACTIONS} interactions.`,
    );

  const state: SanitizerState = {
    pii: { emails: true, phones: true, addresses: true, ...options.pii },
    categories: new Set(),
    replacements: 0,
    variables: new Map(),
  };
  const hosts = new Set<string>();
  const interactions = rawInteractions.map((raw) => {
    const url = parseSandboxUrl(
      raw.request.url,
      allowedHosts,
      raw.request.headers,
    );
    hosts.add(url.hostname);
    return {
      request: {
        method: raw.request.method,
        path: sanitizePath(url, state),
        headers: sanitizeHeaders(
          raw.request.headers,
          SAFE_REQUEST_HEADERS,
          state,
          false,
        ),
        body: sanitizeBody(
          raw.request.body,
          raw.request.binary || raw.request.multipart,
          state,
        ),
      },
      response: {
        status: raw.response.status,
        headers: sanitizeHeaders(
          raw.response.headers,
          SAFE_RESPONSE_HEADERS,
          state,
          true,
        ),
        body: sanitizeBody(
          raw.response.body,
          raw.response.binary || raw.response.multipart,
          state,
        ),
      },
    };
  });

  const title = normalizeTitle(options.title ?? "Sandbox recording");
  const summary: ScenarioSanitizationSummary = {
    categories: [...state.categories].sort(),
    replacements: state.replacements,
    requiresApproval: state.categories.size > 0,
  };
  const bundle: ScenarioBundle = {
    schemaVersion: 1,
    kind: "ghostapi.scenario-bundle",
    metadata: {
      title,
      recordedAt: options.recordedAt ?? new Date().toISOString(),
      sandboxHosts: [...hosts].sort(),
    },
    sanitization: summary,
    variables: [...state.variables.values()],
    interactions,
  };
  return validateScenarioBundle(bundle);
}

export async function prepareScenarioRecordingFromFile(
  path: string,
  options: ScenarioRecordingOptions,
  projectRoot = process.cwd(),
): Promise<ScenarioBundle> {
  const source = await readBoundedJson(
    path,
    projectRoot,
    MAX_CAPTURE_BYTES,
    "Recording input",
  );
  return prepareScenarioRecording(source, options);
}

export async function writeScenarioBundle(
  bundle: ScenarioBundle,
  outPath?: string,
  projectRoot = process.cwd(),
): Promise<string> {
  const valid = validateScenarioBundle(bundle);
  const target =
    outPath === undefined
      ? join(
          getDataPaths().scenarios,
          `${slugify(valid.metadata.title)}.bundle.json`,
        )
      : await resolveOutputPath(outPath, projectRoot);
  const serialized = JSON.stringify(valid);
  if (Buffer.byteLength(serialized, "utf8") > MAX_BUNDLE_BYTES)
    throw new ScenarioBundleError(
      `Scenario bundle exceeds ${MAX_BUNDLE_BYTES} bytes.`,
    );
  await atomicWriteJson(target, valid);
  return target;
}

export async function loadScenarioBundle(
  path: string,
  projectRoot = process.cwd(),
): Promise<ScenarioBundle> {
  return validateScenarioBundle(
    await readBoundedJson(
      path,
      projectRoot,
      MAX_BUNDLE_BYTES,
      "Scenario bundle",
    ),
  );
}

export function createScenarioReplayer(
  bundle: ScenarioBundle,
): ScenarioReplayer {
  return new ScenarioReplayer(validateScenarioBundle(bundle));
}

export function formatScenarioSanitizationSummary(
  summary: ScenarioSanitizationSummary,
): string {
  const categories =
    summary.categories.length === 0 ? "none" : summary.categories.join(", ");
  return [
    "GhostAPI recording sanitization summary",
    `Categories: ${categories}`,
    `Replacements: ${summary.replacements}`,
    `Approval required: ${summary.requiresApproval ? "yes" : "no"}`,
  ].join("\n");
}

export function validateScenarioBundle(input: unknown): ScenarioBundle {
  const root = readObject(
    migrateScenarioBundle(input),
    "Scenario bundle must be an object.",
  );
  assertExactKeys(
    root,
    [
      "schemaVersion",
      "kind",
      "metadata",
      "sanitization",
      "variables",
      "interactions",
    ],
    "Scenario bundle",
  );
  if (root.schemaVersion !== 1)
    throw new ScenarioBundleError(
      "Unsupported scenario bundle schema version.",
    );
  if (root.kind !== "ghostapi.scenario-bundle")
    throw new ScenarioBundleError("Scenario bundle kind is invalid.");

  const metadata = readObject(
    root.metadata,
    "Scenario bundle metadata is invalid.",
  );
  assertExactKeys(
    metadata,
    ["title", "recordedAt", "sandboxHosts"],
    "Scenario bundle metadata",
  );
  const title = normalizeTitle(metadata.title);
  if (!isTimestamp(metadata.recordedAt))
    throw new ScenarioBundleError(
      "Scenario bundle recordedAt must be an ISO timestamp.",
    );
  const sandboxHosts = readHostArray(metadata.sandboxHosts);

  const sanitization = readObject(
    root.sanitization,
    "Scenario bundle sanitization summary is invalid.",
  );
  assertExactKeys(
    sanitization,
    ["categories", "replacements", "requiresApproval"],
    "Scenario bundle sanitization summary",
  );
  const categories = readStringArray(
    sanitization.categories,
    "Scenario bundle sanitization categories are invalid.",
  );
  if (
    !Number.isInteger(sanitization.replacements) ||
    (sanitization.replacements as number) < 0 ||
    typeof sanitization.requiresApproval !== "boolean"
  ) {
    throw new ScenarioBundleError(
      "Scenario bundle sanitization summary is invalid.",
    );
  }

  if (!Array.isArray(root.variables) || root.variables.length > MAX_VARIABLES)
    throw new ScenarioBundleError(
      `Scenario bundle variables must contain at most ${MAX_VARIABLES} entries.`,
    );
  const names = new Set<string>();
  const variables = root.variables.map((entry) => {
    const variable = readObject(entry, "Scenario bundle variable is invalid.");
    assertExactKeys(variable, ["name", "value"], "Scenario bundle variable");
    if (
      typeof variable.name !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(variable.name) ||
      typeof variable.value !== "string" ||
      variable.value.length > 2_000 ||
      sanitizeSecretString(variable.value) !== variable.value
    ) {
      throw new ScenarioBundleError("Scenario bundle variable is invalid.");
    }
    if (names.has(variable.name))
      throw new ScenarioBundleError(
        `Scenario bundle variable is duplicated: ${variable.name}`,
      );
    names.add(variable.name);
    return { name: variable.name, value: variable.value };
  });

  if (
    !Array.isArray(root.interactions) ||
    root.interactions.length === 0 ||
    root.interactions.length > MAX_INTERACTIONS
  ) {
    throw new ScenarioBundleError(
      `Scenario bundle interactions must contain 1-${MAX_INTERACTIONS} entries.`,
    );
  }
  const interactions = root.interactions.map((entry) =>
    normalizeBundleInteraction(entry, names),
  );
  return {
    schemaVersion: 1,
    kind: "ghostapi.scenario-bundle",
    metadata: {
      title,
      recordedAt: metadata.recordedAt as string,
      sandboxHosts,
    },
    sanitization: {
      categories: [...new Set(categories)].sort(),
      replacements: sanitization.replacements as number,
      requiresApproval: sanitization.requiresApproval as boolean,
    },
    variables,
    interactions,
  };
}

export function migrateScenarioBundle(input: unknown): unknown {
  const source = readObject(input, "Scenario bundle must be an object.");
  if (source.schemaVersion === 1) return source;
  if (source.schemaVersion !== 0)
    throw new ScenarioBundleError(
      "Unsupported scenario bundle schema version; no migration is registered.",
    );
  assertExactKeys(
    source,
    [
      "schemaVersion",
      "kind",
      "title",
      "recordedAt",
      "sandboxHosts",
      "variables",
      "interactions",
    ],
    "Scenario bundle v0",
  );
  return {
    schemaVersion: 1,
    kind: source.kind,
    metadata: {
      title: source.title,
      recordedAt: source.recordedAt,
      sandboxHosts: source.sandboxHosts,
    },
    // A migrated legacy bundle has no verifiable sanitizer receipt, so force operator review.
    sanitization: {
      categories: ["legacy-bundle"],
      replacements: 0,
      requiresApproval: true,
    },
    variables: source.variables,
    interactions: source.interactions,
  };
}

function normalizeBundleInteraction(
  input: unknown,
  variableNames: Set<string>,
): ScenarioBundleInteraction {
  const interaction = readObject(
    input,
    "Scenario bundle interaction is invalid.",
  );
  assertExactKeys(
    interaction,
    ["request", "response"],
    "Scenario bundle interaction",
  );
  const request = normalizeBundleRequest(interaction.request, variableNames);
  const response = normalizeBundleResponse(interaction.response, variableNames);
  return { request, response };
}

function normalizeBundleRequest(
  input: unknown,
  variableNames: Set<string>,
): ScenarioBundleInteraction["request"] {
  const request = readObject(input, "Scenario bundle request is invalid.");
  assertExactKeys(
    request,
    ["method", "path", "headers", "body"],
    "Scenario bundle request",
  );
  const method = normalizeMethod(request.method);
  const path = normalizeRelativePath(request.path);
  const headers = validateHeaders(
    request.headers,
    SAFE_REQUEST_HEADERS,
    variableNames,
    false,
  );
  validateValue(request.body, variableNames);
  return { method, path, headers, body: structuredClone(request.body) };
}

function normalizeBundleResponse(
  input: unknown,
  variableNames: Set<string>,
): ScenarioBundleInteraction["response"] {
  const response = readObject(input, "Scenario bundle response is invalid.");
  assertExactKeys(
    response,
    ["status", "headers", "body"],
    "Scenario bundle response",
  );
  if (
    !Number.isInteger(response.status) ||
    (response.status as number) < 100 ||
    (response.status as number) > 599
  )
    throw new ScenarioBundleError(
      "Scenario bundle response status must be 100-599.",
    );
  const headers = validateHeaders(
    response.headers,
    SAFE_RESPONSE_HEADERS,
    variableNames,
    true,
  );
  validateValue(response.body, variableNames);
  return {
    status: response.status as number,
    headers,
    body: structuredClone(response.body),
  };
}

function parseCapture(input: unknown): RawInteraction[] {
  const capture = readObject(input, "Recording input must be an object.");
  if (Array.isArray(capture.interactions))
    return capture.interactions.map(parseDirectInteraction);
  const log = readObject(
    capture.log,
    "Recording input must contain interactions or HAR log.entries.",
  );
  if (!Array.isArray(log.entries))
    throw new ScenarioBundleError(
      "HAR recording input must contain log.entries.",
    );
  return log.entries.map(parseHarInteraction);
}

function parseDirectInteraction(input: unknown): RawInteraction {
  const interaction = readObject(input, "Recording interaction is invalid.");
  const request = readObject(
    interaction.request,
    "Recording request is invalid.",
  );
  const response = readObject(
    interaction.response,
    "Recording response is invalid.",
  );
  const requestHeaders = readHeaderInput(request.headers);
  const responseHeaders = readHeaderInput(response.headers);
  return {
    request: {
      method: normalizeMethod(request.method),
      url: readUrl(request.url),
      headers: requestHeaders,
      body: request.body ?? null,
      binary: request.bodyEncoding === "base64",
      multipart: isMultipart(requestHeaders),
    },
    response: {
      status: readStatus(response.status),
      headers: responseHeaders,
      body: response.body ?? null,
      binary: response.bodyEncoding === "base64",
      multipart: isMultipart(responseHeaders),
    },
  };
}

function parseHarInteraction(input: unknown): RawInteraction {
  const entry = readObject(input, "HAR entry is invalid.");
  const request = readObject(entry.request, "HAR request is invalid.");
  const response = readObject(entry.response, "HAR response is invalid.");
  const requestHeaders = readHeaderInput(request.headers);
  const responseHeaders = readHeaderInput(response.headers);
  const postData =
    request.postData === undefined
      ? null
      : readObject(request.postData, "HAR request postData is invalid.");
  const content =
    response.content === undefined
      ? null
      : readObject(response.content, "HAR response content is invalid.");
  return {
    request: {
      method: normalizeMethod(request.method),
      url: readUrl(request.url),
      headers: requestHeaders,
      body: parseCaptureText(postData?.text, postData?.mimeType),
      binary: postData?.encoding === "base64",
      multipart:
        isMultipart(requestHeaders) || isMultipartMime(postData?.mimeType),
    },
    response: {
      status: readStatus(response.status),
      headers: responseHeaders,
      body: parseCaptureText(content?.text, content?.mimeType),
      binary: content?.encoding === "base64",
      multipart:
        isMultipart(responseHeaders) || isMultipartMime(content?.mimeType),
    },
  };
}

function parseCaptureText(value: unknown, mimeType: unknown): unknown {
  if (typeof value !== "string") return null;
  if (typeof mimeType === "string" && /json/i.test(mimeType)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function sanitizePath(url: URL, state: SanitizerState): string {
  const query: string[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      mark(state, "known-api-key");
      continue;
    }
    const sanitized = sanitizeValue(value, state, key);
    query.push(
      `${encodeURIComponent(key)}=${encodeScenarioQueryValue(typeof sanitized === "string" ? sanitized : String(sanitized))}`,
    );
  }
  const suffix = query.length === 0 ? "" : `?${query.join("&")}`;
  const sanitizedPathname = sanitizeSecretString(url.pathname);
  if (sanitizedPathname !== url.pathname) mark(state, "known-api-key");
  return `${replaceUnstableIdentifiers(sanitizedPathname, state, "path_id")}${suffix}`;
}

function encodeScenarioQueryValue(value: string): string {
  return encodeURIComponent(value).replace(
    /%7B%7Bghostapi\.var\.([a-z0-9_]+)%7D%7D/gi,
    "{{ghostapi.var.$1}}",
  );
}

function sanitizeHeaders(
  headers: Record<string, string>,
  allowed: Set<string>,
  state: SanitizerState,
  response: boolean,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (isSecretFieldName(lower)) {
      mark(
        state,
        lower.includes("cookie")
          ? "cookie"
          : lower.includes("authorization")
            ? "authorization"
            : "secret-header",
      );
      continue;
    }
    if (!allowed.has(lower)) continue;
    if (response && lower === "location" && !isSafeRelativeLocation(value)) {
      sanitized.location = "/__ghostapi_redirect_blocked__";
      mark(state, "external-redirect");
      continue;
    }
    const valueAfterSecretSanitization = sanitizeSecretString(value);
    if (valueAfterSecretSanitization !== value) mark(state, "known-api-key");
    sanitized[lower] = valueAfterSecretSanitization.slice(0, 2_000);
  }
  return sanitized;
}

function sanitizeBody(
  value: unknown,
  binary: boolean,
  state: SanitizerState,
): unknown {
  if (binary) {
    mark(state, "binary-payload");
    return "[GhostAPI omitted binary payload]";
  }
  return sanitizeValue(value, state);
}

function sanitizeValue(
  value: unknown,
  state: SanitizerState,
  key?: string,
  depth = 0,
): unknown {
  if (depth > MAX_VALUE_DEPTH)
    throw new ScenarioBundleError(
      `Recording value exceeds maximum depth of ${MAX_VALUE_DEPTH}.`,
    );
  if (Array.isArray(value))
    return value.map((entry) => sanitizeValue(entry, state, key, depth + 1));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_VALUE_KEYS)
      throw new ScenarioBundleError(
        `Recording object exceeds ${MAX_VALUE_KEYS} keys.`,
      );
    return Object.fromEntries(
      entries.flatMap(([childKey, childValue]) => {
        if (isSecretFieldName(childKey)) {
          mark(state, "known-api-key");
          return [];
        }
        return [
          [childKey, sanitizeValue(childValue, state, childKey, depth + 1)],
        ];
      }),
    );
  }
  if (typeof value !== "string") return value;

  if (key !== undefined && isSecretFieldName(key)) {
    mark(state, "known-api-key");
    return "***";
  }
  if (
    state.pii.addresses &&
    key !== undefined &&
    /(?:address|line1|line2|city|state|postal|zip)/i.test(key)
  ) {
    mark(state, "address");
    return "[redacted:address]";
  }

  let result = sanitizeSecretString(value);
  if (result !== value) mark(state, "known-api-key");
  if (
    state.pii.emails &&
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(result)
  ) {
    result = result.replace(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      "[redacted:email]",
    );
    mark(state, "email");
  }
  if (
    state.pii.phones &&
    /(?:\+\d[\d(). -]{7,}\d|\b\d{3}[ .-]\d{3}[ .-]\d{4}\b)/.test(result)
  ) {
    result = result.replace(
      /(?:\+\d[\d(). -]{7,}\d|\b\d{3}[ .-]\d{3}[ .-]\d{4}\b)/g,
      "[redacted:phone]",
    );
    mark(state, "phone");
  }
  if (isTimestamp(result))
    return variableReference(
      getVariable(
        state,
        result,
        "timestamp",
        deterministicTimestamp(state.variables.size + 1),
      ),
    );
  return replaceUnstableIdentifiers(result, state, key);
}

function replaceUnstableIdentifiers(
  value: string,
  state: SanitizerState,
  key: string | undefined,
): string {
  return value.replace(
    /\b(?:cus|pi|in|sub|evt|re|ch|pm|price|prod|cs|ord|user|msg|email)_[A-Za-z0-9]+\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    (match) => {
      const prefix = match.includes("_")
        ? match.split("_", 1)[0]!.toLowerCase()
        : "id";
      const nameHint =
        key !== undefined && /id$/i.test(key)
          ? key.replace(/[^a-z0-9]+/gi, "_").toLowerCase()
          : `${prefix}_id`;
      return variableReference(
        getVariable(
          state,
          match,
          nameHint,
          `${prefix}_recorded_${state.variables.size + 1}`,
        ),
      );
    },
  );
}

function getVariable(
  state: SanitizerState,
  raw: string,
  hint: string,
  value: string,
): { name: string; value: string } {
  const existing = state.variables.get(raw);
  if (existing !== undefined) return existing;
  if (state.variables.size >= MAX_VARIABLES)
    throw new ScenarioBundleError(
      `Recording exceeds ${MAX_VARIABLES} stateful variables.`,
    );
  const base =
    hint
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "value";
  let name = base;
  let suffix = 1;
  const names = new Set(
    [...state.variables.values()].map((entry) => entry.name),
  );
  while (names.has(name)) name = `${base}_${suffix++}`;
  const variable = { name, value };
  state.variables.set(raw, variable);
  mark(state, hint === "timestamp" ? "timestamp" : "unstable-id");
  return variable;
}

function variableReference(variable: { name: string }): string {
  return `{{ghostapi.var.${variable.name}}}`;
}

function mark(state: SanitizerState, category: string): void {
  state.categories.add(category);
  state.replacements += 1;
}

function parseSandboxUrl(
  value: string,
  allowedHosts: Set<string>,
  headers: Record<string, string>,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ScenarioBundleError(
      "Recording request URL must be absolute HTTPS.",
    );
  }
  if (url.protocol !== "https:")
    throw new ScenarioBundleError(
      "Recording permits HTTPS sandbox traffic only.",
    );
  if (!allowedHosts.has(url.hostname))
    throw new ScenarioBundleError(
      `Recording host is not explicitly allowed as a sandbox host: ${url.hostname}`,
    );
  if (!looksLikeSandboxHost(url.hostname, headers))
    throw new ScenarioBundleError(
      `Recording host does not pass the sandbox safety check: ${url.hostname}`,
    );
  return url;
}

function looksLikeSandboxHost(
  host: string,
  headers: Record<string, string>,
): boolean {
  if (host === "api.stripe.com")
    return /\b(?:sk|rk)_test_[A-Za-z0-9_-]+/i.test(headers.authorization ?? "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /(?:sandbox|test)/i.test(host)
  );
}

function normalizeAllowedSandboxHosts(hosts: string[]): Set<string> {
  if (hosts.length === 0)
    throw new ScenarioBundleError(
      "Recording requires at least one explicit --allow-sandbox-host.",
    );
  const normalized = hosts
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (
    normalized.length !== hosts.length ||
    normalized.some(
      (host) =>
        !/^[a-z0-9.-]+$/.test(host) ||
        host.includes("..") ||
        host.startsWith(".") ||
        host.endsWith("."),
    )
  ) {
    throw new ScenarioBundleError(
      "Allowed sandbox hosts must be plain host names without paths, ports, or wildcards.",
    );
  }
  return new Set(normalized);
}

function normalizeReplayRequest(
  input: ScenarioReplayRequest,
): ScenarioBundleInteraction["request"] {
  return {
    method: normalizeMethod(input.method),
    path: normalizeRelativePath(input.path),
    headers: normalizeReplayHeaders(input.headers),
    body: sanitizeSecrets(input.body ?? null),
  };
}

function normalizeReplayHeaders(
  headers: ScenarioReplayRequest["headers"],
): Record<string, string> {
  if (headers === undefined) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (SAFE_REQUEST_HEADERS.has(lower))
      result[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function compareRequest(
  expected: ScenarioBundleInteraction["request"],
  actual: ScenarioBundleInteraction["request"],
  bindings: Map<string, string>,
  variables: ScenarioBundle["variables"],
): string[] {
  const mismatches: string[] = [];
  if (expected.method !== actual.method)
    mismatches.push(
      `method expected ${expected.method}, received ${actual.method}`,
    );
  if (!matchTemplate(expected.path, actual.path, bindings, variables))
    mismatches.push(`path expected ${expected.path}, received ${actual.path}`);
  if (!matchValue(expected.headers, actual.headers, bindings, variables))
    mismatches.push("safe request headers differ");
  if (!matchValue(expected.body, actual.body, bindings, variables))
    mismatches.push("request body differs");
  return mismatches;
}

function resolveHeaders(
  headers: Record<string, string>,
  variables: ScenarioBundle["variables"],
  bindings: Map<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      resolveTemplate(value, variables, bindings),
    ]),
  );
}

function resolveVariables(
  value: unknown,
  variables: ScenarioBundle["variables"],
  bindings: Map<string, string>,
): unknown {
  if (Array.isArray(value))
    return value.map((entry) => resolveVariables(entry, variables, bindings));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        resolveVariables(entry, variables, bindings),
      ]),
    );
  return typeof value === "string"
    ? resolveTemplate(value, variables, bindings)
    : value;
}

function resolveTemplate(
  value: string,
  variables: ScenarioBundle["variables"],
  bindings: Map<string, string>,
): string {
  const dictionary = new Map(
    variables.map((entry) => [entry.name, entry.value]),
  );
  return value.replace(VARIABLE_PATTERN, (_match, name: string) => {
    const resolved = bindings.get(name) ?? dictionary.get(name) ?? "";
    bindings.set(name, resolved);
    return resolved;
  });
}

function matchValue(
  expected: unknown,
  actual: unknown,
  bindings: Map<string, string>,
  variables: ScenarioBundle["variables"],
): boolean {
  if (typeof expected === "string" && typeof actual === "string")
    return matchTemplate(expected, actual, bindings, variables);
  if (
    expected === null ||
    actual === null ||
    typeof expected !== "object" ||
    typeof actual !== "object"
  )
    return expected === actual;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    return (
      Array.isArray(expected) &&
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) =>
        matchValue(entry, actual[index], bindings, variables),
      )
    );
  }
  const expectedEntries = Object.entries(expected as Record<string, unknown>);
  const actualRecord = actual as Record<string, unknown>;
  return (
    expectedEntries.length === Object.keys(actualRecord).length &&
    expectedEntries.every(
      ([key, entry]) =>
        Object.hasOwn(actualRecord, key) &&
        matchValue(entry, actualRecord[key], bindings, variables),
    )
  );
}

function matchTemplate(
  expected: string,
  actual: string,
  bindings: Map<string, string>,
  variables: ScenarioBundle["variables"],
): boolean {
  const known = new Set(variables.map((entry) => entry.name));
  const matches = [...expected.matchAll(VARIABLE_PATTERN)];
  if (matches.length === 0) return expected === actual;
  let pattern = "^";
  let cursor = 0;
  const names: string[] = [];
  for (const match of matches) {
    const index = match.index ?? 0;
    pattern += escapeRegExp(expected.slice(cursor, index));
    const name = match[1]!;
    if (!known.has(name)) return false;
    const bound = bindings.get(name);
    pattern += bound === undefined ? "(.+?)" : `(${escapeRegExp(bound)})`;
    names.push(name);
    cursor = index + match[0].length;
  }
  pattern += `${escapeRegExp(expected.slice(cursor))}$`;
  const result = new RegExp(pattern).exec(actual);
  if (result === null) return false;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    const value = result[index + 1]!;
    const existing = bindings.get(name);
    if (existing !== undefined && existing !== value) return false;
    bindings.set(name, value);
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateHeaders(
  input: unknown,
  allowed: Set<string>,
  variableNames: Set<string>,
  response: boolean,
): Record<string, string> {
  const headers = readObject(
    input,
    "Scenario bundle headers must be an object.",
  );
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      !allowed.has(lower) ||
      typeof value !== "string" ||
      value.length > 2_000 ||
      isSecretFieldName(lower)
    )
      throw new ScenarioBundleError(
        `Scenario bundle header is not allowed: ${name}`,
      );
    if (response && lower === "location" && !isSafeRelativeLocation(value))
      throw new ScenarioBundleError(
        "Scenario bundle redirect location must be relative.",
      );
    validateTemplate(value, variableNames);
    normalized[lower] = value;
  }
  return normalized;
}

function validateValue(
  value: unknown,
  variableNames: Set<string>,
  depth = 0,
): void {
  if (depth > MAX_VALUE_DEPTH)
    throw new ScenarioBundleError(
      `Scenario bundle value exceeds maximum depth of ${MAX_VALUE_DEPTH}.`,
    );
  if (typeof value === "string") {
    if (value.length > 64 * 1024)
      throw new ScenarioBundleError(
        "Scenario bundle string exceeds 65536 characters.",
      );
    if (sanitizeSecretString(value) !== value)
      throw new ScenarioBundleError(
        "Scenario bundle contains a secret-shaped value.",
      );
    validateTemplate(value, variableNames);
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return;
  if (Array.isArray(value)) {
    for (const entry of value) validateValue(entry, variableNames, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_VALUE_KEYS)
      throw new ScenarioBundleError(
        `Scenario bundle object exceeds ${MAX_VALUE_KEYS} keys.`,
      );
    for (const [key, entry] of entries) {
      if (isSecretFieldName(key))
        throw new ScenarioBundleError(
          `Scenario bundle contains a secret-shaped field: ${key}`,
        );
      validateValue(entry, variableNames, depth + 1);
    }
    return;
  }
  throw new ScenarioBundleError("Scenario bundle values must be JSON values.");
}

function validateTemplate(value: string, variableNames: Set<string>): void {
  for (const match of value.matchAll(VARIABLE_PATTERN)) {
    if (!variableNames.has(match[1]!))
      throw new ScenarioBundleError(
        `Scenario bundle references an undeclared variable: ${match[1]}`,
      );
  }
  if (value.includes("{{ghostapi.var.")) {
    const stripped = value.replace(VARIABLE_PATTERN, "");
    if (stripped.includes("{{ghostapi.var."))
      throw new ScenarioBundleError(
        "Scenario bundle contains an invalid variable reference.",
      );
  }
}

async function readBoundedJson(
  path: string,
  projectRoot: string,
  limit: number,
  label: string,
): Promise<unknown> {
  const target = await resolveExistingPath(path, projectRoot, label);
  const source = await readFile(target, "utf8");
  if (Buffer.byteLength(source, "utf8") > limit)
    throw new ScenarioBundleError(`${label} exceeds ${limit} bytes.`);
  try {
    return JSON.parse(source);
  } catch {
    throw new ScenarioBundleError(`${label} is not valid JSON.`);
  }
}

async function resolveExistingPath(
  path: string,
  projectRoot: string,
  label: string,
): Promise<string> {
  const target = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  assertPathInsideAllowedRoots(projectRoot, target, label);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink())
    throw new ScenarioBundleError(
      `${label} must be a regular non-symlink file.`,
    );
  if (!(await isRealPathInsideAllowedRoots(target, projectRoot)))
    throw new ScenarioBundleError(
      `${label} resolves outside the project root or GHOSTAPI_DATA_DIR through a symlink.`,
    );
  return target;
}

async function resolveOutputPath(
  path: string,
  projectRoot: string,
): Promise<string> {
  const target = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  assertPathInsideAllowedRoots(projectRoot, target, "Scenario bundle output");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new ScenarioBundleError(
      "Scenario bundle output parent must be a real directory, not a symlink.",
    );
  if (!(await isRealPathInsideAllowedRoots(dirname(target), projectRoot)))
    throw new ScenarioBundleError(
      "Scenario bundle output parent resolves outside the project root or GHOSTAPI_DATA_DIR through a symlink.",
    );
  const existing = await lstat(target).catch((error: unknown) =>
    isErrorCode(error, "ENOENT") ? null : Promise.reject(error),
  );
  if (existing?.isSymbolicLink())
    throw new ScenarioBundleError(
      "Scenario bundle output path must not be a symlink.",
    );
  return target;
}

function assertPathInsideAllowedRoots(
  projectRoot: string,
  target: string,
  label: string,
): void {
  if (!isInside(projectRoot, target) && !isInside(getDataPaths().root, target))
    throw new ScenarioBundleError(
      `${label} path traversal outside the project root or GHOSTAPI_DATA_DIR is not allowed.`,
    );
  if (basename(target).trim() === "")
    throw new ScenarioBundleError(`${label} path must include a file name.`);
}

function isInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), target);
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function isRealPathInsideAllowedRoots(
  target: string,
  projectRoot: string,
): Promise<boolean> {
  const realTarget = await realpath(target);
  const realProjectRoot = await realpath(projectRoot);
  const dataRoot = await realpath(getDataPaths().root).catch(() => null);
  return (
    isInside(realProjectRoot, realTarget) ||
    (dataRoot !== null && isInside(dataRoot, realTarget))
  );
}

function readObject(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ScenarioBundleError(message);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (unknown.length > 0)
    throw new ScenarioBundleError(
      `${label} contains unknown field: ${unknown[0]}`,
    );
}

function readHeaderInput(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((entry) => {
        const header = readObject(entry, "Capture header is invalid.");
        if (typeof header.name !== "string" || typeof header.value !== "string")
          throw new ScenarioBundleError("Capture header is invalid.");
        return [header.name.toLowerCase(), header.value];
      }),
    );
  }
  const record = readObject(value, "Capture headers are invalid.");
  return Object.fromEntries(
    Object.entries(record).map(([name, headerValue]) => {
      if (typeof headerValue !== "string")
        throw new ScenarioBundleError("Capture header values must be strings.");
      return [name.toLowerCase(), headerValue];
    }),
  );
}

function normalizeMethod(value: unknown): string {
  if (typeof value !== "string" || !METHODS.has(value.toUpperCase()))
    throw new ScenarioBundleError("HTTP method is invalid.");
  return value.toUpperCase();
}

function readUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8_000)
    throw new ScenarioBundleError("Recording request URL is invalid.");
  return value;
}

function readStatus(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 100 ||
    (value as number) > 599
  )
    throw new ScenarioBundleError("Capture response status must be 100-599.");
  return value as number;
}

function normalizeRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8_000 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\r\n]/.test(value)
  ) {
    throw new ScenarioBundleError(
      "Scenario request path must be a relative path.",
    );
  }
  return value;
}

function readHostArray(value: unknown): string[] {
  const hosts = readStringArray(
    value,
    "Scenario bundle sandbox hosts are invalid.",
  ).map((host) => host.toLowerCase());
  if (hosts.length === 0 || hosts.some((host) => !/^[a-z0-9.-]+$/.test(host)))
    throw new ScenarioBundleError("Scenario bundle sandbox hosts are invalid.");
  return [...new Set(hosts)].sort();
}

function readStringArray(value: unknown, message: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length > 256)
  )
    throw new ScenarioBundleError(message);
  return value as string[];
}

function isMultipart(headers: Record<string, string>): boolean {
  return isMultipartMime(headers["content-type"]);
}

function isMultipartMime(value: unknown): boolean {
  return typeof value === "string" && /^multipart\//i.test(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function deterministicTimestamp(index: number): string {
  return `2020-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`;
}

function normalizeTitle(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.trim().length > 120
  )
    throw new ScenarioBundleError(
      "Scenario bundle title must be 1-120 characters.",
    );
  return value.trim();
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "sandbox-recording"
  );
}

function serializedBytes(value: unknown, label: string): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new ScenarioBundleError(`${label} must be JSON-serializable.`);
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
