import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { getProviderManifests } from "../providers/registry.js";
import { atomicWriteJson } from "../storage/fileStore.js";
import { sanitizeSecretString } from "../security/secrets.js";
import {
  prepareScenarioRecording,
  type ScenarioBundle,
  type ScenarioRecordingOptions,
} from "../scenarios/scenarioBundle.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_CONTRACT_BYTES = 512 * 1024;
const MAX_PATHS = 200;
const MAX_OPERATIONS = 400;
const MAX_SCHEMA_DEPTH = 20;
const MAX_PROPERTIES = 100;
const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export type ContractSchema = {
  type?:
    "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
  enum?: Array<string | number | boolean | null>;
  required?: string[];
  properties?: Record<string, ContractSchema>;
  items?: ContractSchema;
};

export type ContractOperation = {
  method: string;
  path: string;
  request?: ContractSchema;
  responses: Record<string, ContractSchema | null>;
};

export type ContractProviderCapability = {
  name: string;
  packVersion: string | null;
  capabilities: Record<string, boolean>;
};

export type GhostApiContract = {
  schemaVersion: 1;
  kind: "ghostapi.contract";
  metadata: {
    title: string;
    source: "openapi" | "har";
    importedAt: string;
  };
  operations: ContractOperation[];
  providerCapabilities: ContractProviderCapability[];
};

export type OpenApiImportOptions = {
  title?: string;
  importedAt?: string;
};

export type HarContractImportOptions = ScenarioRecordingOptions & {
  title?: string;
  importedAt?: string;
};

export type ContractDiffSeverity = "breaking" | "non-breaking" | "uncertain";

export type ContractDiffFinding = {
  id: string;
  severity: ContractDiffSeverity;
  message: string;
};

export type ContractDiff = {
  schemaVersion: 1;
  kind: "ghostapi.contract-diff";
  baselineHash: string;
  candidateHash: string;
  findings: ContractDiffFinding[];
  summary: { breaking: number; nonBreaking: number; uncertain: number };
};

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export function importOpenApiContract(
  input: unknown,
  options: OpenApiImportOptions = {},
): GhostApiContract {
  assertSerializedSize(input, "OpenAPI input", MAX_INPUT_BYTES);
  const document = objectAt(input, "OpenAPI document must be an object.");
  assertExactKeys(
    document,
    ["openapi", "info", "paths", "servers"],
    "OpenAPI document",
  );
  assertNoUnsupportedOpenApiFeatures(document, "OpenAPI document");
  if (
    typeof document.openapi !== "string" ||
    !/^3\.0\.\d+(?:[-+].*)?$/.test(document.openapi)
  ) {
    throw new ContractError(
      "Only OpenAPI 3.0.x is supported. Convert Swagger/OpenAPI 2.x or OpenAPI 3.1 before import.",
    );
  }
  if (document.servers !== undefined)
    throw new ContractError(
      "OpenAPI servers are unsupported because GhostAPI imports contracts locally and never resolves remote URLs.",
    );
  const paths = objectAt(document.paths, "OpenAPI paths must be an object.");
  const pathEntries = Object.entries(paths);
  if (pathEntries.length === 0 || pathEntries.length > MAX_PATHS)
    throw new ContractError(
      `OpenAPI paths must contain 1-${MAX_PATHS} entries.`,
    );

  const operations: ContractOperation[] = [];
  for (const [path, pathItem] of pathEntries) {
    validateOpenApiPath(path);
    const item = objectAt(pathItem, `OpenAPI path ${path} must be an object.`);
    assertNoUnsupportedOpenApiFeatures(item, `OpenAPI path ${path}`);
    for (const [methodName, operationValue] of Object.entries(item)) {
      const method = methodName.toUpperCase();
      if (!HTTP_METHODS.has(method)) {
        if (["summary", "description"].includes(methodName)) continue;
        throw new ContractError(
          `OpenAPI path ${path} uses unsupported field or method: ${methodName}. Supported methods: ${[...HTTP_METHODS].join(", ")}.`,
        );
      }
      operations.push(parseOpenApiOperation(path, method, operationValue));
      if (operations.length > MAX_OPERATIONS)
        throw new ContractError(
          `OpenAPI document exceeds ${MAX_OPERATIONS} operations.`,
        );
    }
  }
  if (operations.length === 0)
    throw new ContractError(
      "OpenAPI document does not contain any supported operations.",
    );
  const infoTitle =
    document.info === undefined
      ? undefined
      : objectAt(document.info, "OpenAPI info must be an object.").title;
  return validateContract({
    schemaVersion: 1,
    kind: "ghostapi.contract",
    metadata: {
      title: normalizeTitle(options.title ?? infoTitle ?? "OpenAPI import"),
      source: "openapi",
      importedAt: options.importedAt ?? new Date().toISOString(),
    },
    operations,
    providerCapabilities: currentProviderCapabilities(),
  });
}

export function importHarContract(
  input: unknown,
  options: HarContractImportOptions,
): { bundle: ScenarioBundle; contract: GhostApiContract } {
  const bundle = prepareScenarioRecording(input, options);
  return {
    bundle,
    contract: contractFromScenarioBundle(
      bundle,
      options.title,
      options.importedAt,
    ),
  };
}

export function contractFromScenarioBundle(
  bundle: ScenarioBundle,
  title = bundle.metadata.title,
  importedAt = bundle.metadata.recordedAt,
): GhostApiContract {
  const operations = new Map<string, ContractOperation>();
  for (const interaction of bundle.interactions) {
    const key = `${interaction.request.method} ${pathWithoutQuery(interaction.request.path)}`;
    const existing = operations.get(key);
    const responseSchema = inferSchema(interaction.response.body);
    if (existing === undefined) {
      operations.set(key, {
        method: interaction.request.method,
        path: pathWithoutQuery(interaction.request.path),
        request: inferSchema(interaction.request.body),
        responses: { [String(interaction.response.status)]: responseSchema },
      });
      continue;
    }
    existing.responses[String(interaction.response.status)] =
      mergeSchemas(
        existing.responses[String(interaction.response.status)],
        responseSchema,
      ) ?? null;
    existing.request = mergeSchemas(
      existing.request,
      inferSchema(interaction.request.body),
    );
  }
  return validateContract({
    schemaVersion: 1,
    kind: "ghostapi.contract",
    metadata: { title: normalizeTitle(title), source: "har", importedAt },
    operations: [...operations.values()].sort(compareOperations),
    providerCapabilities: currentProviderCapabilities(),
  });
}

export async function importOpenApiContractFromFile(
  path: string,
  options: OpenApiImportOptions = {},
  projectRoot = process.cwd(),
): Promise<GhostApiContract> {
  return importOpenApiContract(
    await readBoundedJson(path, projectRoot, "OpenAPI input"),
    options,
  );
}

export async function importHarContractFromFile(
  path: string,
  options: HarContractImportOptions,
  projectRoot = process.cwd(),
): Promise<{ bundle: ScenarioBundle; contract: GhostApiContract }> {
  return importHarContract(
    await readBoundedJson(path, projectRoot, "HAR input"),
    options,
  );
}

export async function writeContract(
  contract: GhostApiContract,
  outPath?: string,
  projectRoot = process.cwd(),
): Promise<string> {
  const valid = validateContract(contract);
  const target =
    outPath === undefined
      ? join(
          getDataPaths().contracts,
          `${slugify(valid.metadata.title)}.contract.json`,
        )
      : await resolveOutputPath(outPath, projectRoot);
  const serialized = JSON.stringify(valid);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONTRACT_BYTES)
    throw new ContractError(`Contract exceeds ${MAX_CONTRACT_BYTES} bytes.`);
  await atomicWriteJson(target, valid);
  return target;
}

export async function loadContract(
  path: string,
  projectRoot = process.cwd(),
): Promise<GhostApiContract> {
  return validateContract(
    await readBoundedJson(path, projectRoot, "Contract", MAX_CONTRACT_BYTES),
  );
}

export function validateContract(input: unknown): GhostApiContract {
  const root = objectAt(input, "Contract must be an object.");
  assertExactKeys(
    root,
    ["schemaVersion", "kind", "metadata", "operations", "providerCapabilities"],
    "Contract",
  );
  if (root.schemaVersion !== 1 || root.kind !== "ghostapi.contract")
    throw new ContractError("Unsupported contract schema or kind.");
  const metadata = objectAt(root.metadata, "Contract metadata is invalid.");
  assertExactKeys(
    metadata,
    ["title", "source", "importedAt"],
    "Contract metadata",
  );
  if (metadata.source !== "openapi" && metadata.source !== "har")
    throw new ContractError("Contract metadata source must be openapi or har.");
  if (!isTimestamp(metadata.importedAt))
    throw new ContractError(
      "Contract metadata importedAt must be an ISO timestamp.",
    );
  if (
    !Array.isArray(root.operations) ||
    root.operations.length === 0 ||
    root.operations.length > MAX_OPERATIONS
  )
    throw new ContractError(
      `Contract operations must contain 1-${MAX_OPERATIONS} entries.`,
    );
  const operations = root.operations
    .map((operation) => validateOperation(operation))
    .sort(compareOperations);
  const keys = new Set<string>();
  for (const operation of operations) {
    const key = `${operation.method} ${operation.path}`;
    if (keys.has(key))
      throw new ContractError(`Contract operation is duplicated: ${key}`);
    keys.add(key);
  }
  if (
    !Array.isArray(root.providerCapabilities) ||
    root.providerCapabilities.length > 20
  )
    throw new ContractError("Contract provider capabilities are invalid.");
  const providerCapabilities = root.providerCapabilities
    .map(validateCapability)
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    schemaVersion: 1,
    kind: "ghostapi.contract",
    metadata: {
      title: normalizeTitle(metadata.title),
      source: metadata.source,
      importedAt: metadata.importedAt,
    },
    operations,
    providerCapabilities,
  };
}

export function diffContracts(
  baselineInput: GhostApiContract,
  candidateInput: GhostApiContract,
): ContractDiff {
  const baseline = validateContract(baselineInput);
  const candidate = validateContract(candidateInput);
  const findings: ContractDiffFinding[] = [];
  const baselineOperations = new Map(
    baseline.operations.map((operation) => [
      operationKey(operation),
      operation,
    ]),
  );
  const candidateOperations = new Map(
    candidate.operations.map((operation) => [
      operationKey(operation),
      operation,
    ]),
  );
  for (const key of [...baselineOperations.keys()].sort()) {
    if (!candidateOperations.has(key))
      findings.push(
        finding(
          "endpoint-removed",
          key,
          "breaking",
          `Endpoint removed: ${key}. Existing callers can no longer rely on this operation.`,
        ),
      );
  }
  for (const key of [...candidateOperations.keys()].sort()) {
    if (!baselineOperations.has(key))
      findings.push(
        finding(
          "endpoint-added",
          key,
          "non-breaking",
          `Endpoint added: ${key}.`,
        ),
      );
  }
  for (const key of [...baselineOperations.keys()]
    .filter((entry) => candidateOperations.has(entry))
    .sort()) {
    const before = baselineOperations.get(key)!;
    const after = candidateOperations.get(key)!;
    diffSchema(
      before.request,
      after.request,
      `${key} request`,
      "request",
      findings,
    );
    const beforeStatuses = new Set(Object.keys(before.responses));
    const afterStatuses = new Set(Object.keys(after.responses));
    for (const status of [...beforeStatuses]
      .filter((value) => !afterStatuses.has(value))
      .sort())
      findings.push(
        finding(
          "response-status-removed",
          `${key} ${status}`,
          "breaking",
          `Response status ${status} removed from ${key}.`,
        ),
      );
    for (const status of [...afterStatuses]
      .filter((value) => !beforeStatuses.has(value))
      .sort())
      findings.push(
        finding(
          "response-status-added",
          `${key} ${status}`,
          "uncertain",
          `Response status ${status} added to ${key}; client handling is unknown.`,
        ),
      );
    for (const status of [...beforeStatuses]
      .filter((value) => afterStatuses.has(value))
      .sort())
      diffSchema(
        before.responses[status] ?? undefined,
        after.responses[status] ?? undefined,
        `${key} response ${status}`,
        "response",
        findings,
      );
  }
  diffProviderCapabilities(
    baseline.providerCapabilities,
    candidate.providerCapabilities,
    findings,
  );
  const sorted = findings.sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  return {
    schemaVersion: 1,
    kind: "ghostapi.contract-diff",
    baselineHash: contractHash(baseline),
    candidateHash: contractHash(candidate),
    findings: sorted,
    summary: {
      breaking: sorted.filter((entry) => entry.severity === "breaking").length,
      nonBreaking: sorted.filter((entry) => entry.severity === "non-breaking")
        .length,
      uncertain: sorted.filter((entry) => entry.severity === "uncertain")
        .length,
    },
  };
}

export function formatContractDiff(diff: ContractDiff): string {
  return [
    `GhostAPI contract diff: ${diff.summary.breaking === 0 ? "PASS" : "FAIL"}`,
    `Baseline: ${diff.baselineHash}`,
    `Candidate: ${diff.candidateHash}`,
    `Findings: ${diff.summary.breaking} breaking, ${diff.summary.nonBreaking} non-breaking, ${diff.summary.uncertain} uncertain`,
    ...diff.findings.map(
      (entry) => `  ${entry.severity.toUpperCase()} ${entry.message}`,
    ),
  ].join("\n");
}

export function contractHash(contract: GhostApiContract): string {
  return createHash("sha256")
    .update(stableStringify(validateContract(contract)), "utf8")
    .digest("hex");
}

function parseOpenApiOperation(
  path: string,
  method: string,
  value: unknown,
): ContractOperation {
  const operation = objectAt(
    value,
    `OpenAPI ${method} ${path} must be an object.`,
  );
  assertNoUnsupportedOpenApiFeatures(operation, `OpenAPI ${method} ${path}`);
  const allowed = [
    "summary",
    "description",
    "operationId",
    "tags",
    "requestBody",
    "responses",
  ];
  assertExactKeys(operation, allowed, `OpenAPI ${method} ${path}`);
  const request =
    operation.requestBody === undefined
      ? undefined
      : parseRequestBody(
          operation.requestBody,
          `OpenAPI ${method} ${path} requestBody`,
        );
  const responsesRecord = objectAt(
    operation.responses,
    `OpenAPI ${method} ${path} must declare responses.`,
  );
  const responseEntries = Object.entries(responsesRecord);
  if (responseEntries.length === 0 || responseEntries.length > 20)
    throw new ContractError(
      `OpenAPI ${method} ${path} responses must contain 1-20 entries.`,
    );
  const responses: Record<string, ContractSchema | null> = {};
  for (const [status, response] of responseEntries) {
    if (!/^(?:[1-5][0-9]{2}|default)$/.test(status))
      throw new ContractError(
        `OpenAPI ${method} ${path} has unsupported response status: ${status}.`,
      );
    responses[status] = parseResponse(
      response,
      `OpenAPI ${method} ${path} response ${status}`,
    );
  }
  return {
    method,
    path,
    ...(request === undefined ? {} : { request }),
    responses,
  };
}

function parseRequestBody(
  value: unknown,
  label: string,
): ContractSchema | undefined {
  const body = objectAt(value, `${label} must be an object.`);
  assertNoUnsupportedOpenApiFeatures(body, label);
  assertExactKeys(body, ["description", "required", "content"], label);
  return parseContent(body.content, label);
}

function parseResponse(value: unknown, label: string): ContractSchema | null {
  const response = objectAt(value, `${label} must be an object.`);
  assertNoUnsupportedOpenApiFeatures(response, label);
  assertExactKeys(response, ["description", "content", "headers"], label);
  if (response.headers !== undefined)
    throw new ContractError(
      `${label} headers are unsupported; import JSON response schemas only.`,
    );
  return response.content === undefined
    ? null
    : (parseContent(response.content, label) ?? null);
}

function parseContent(
  value: unknown,
  label: string,
): ContractSchema | undefined {
  const content = objectAt(value, `${label} content must be an object.`);
  const entries = Object.entries(content);
  if (
    entries.length !== 1 ||
    entries[0]![0].toLowerCase() !== "application/json"
  )
    throw new ContractError(
      `${label} supports exactly one application/json content entry.`,
    );
  const media = objectAt(
    entries[0]![1],
    `${label} application/json media type must be an object.`,
  );
  assertNoUnsupportedOpenApiFeatures(
    media,
    `${label} application/json media type`,
  );
  assertExactKeys(media, ["schema"], `${label} application/json media type`);
  return media.schema === undefined
    ? undefined
    : parseOpenApiSchema(media.schema, `${label} schema`);
}

function parseOpenApiSchema(
  value: unknown,
  label: string,
  depth = 0,
): ContractSchema {
  if (depth > MAX_SCHEMA_DEPTH)
    throw new ContractError(
      `${label} exceeds schema recursion depth ${MAX_SCHEMA_DEPTH}.`,
    );
  const schema = objectAt(value, `${label} must be an object.`);
  assertNoUnsupportedOpenApiFeatures(schema, label);
  assertExactKeys(
    schema,
    [
      "type",
      "enum",
      "required",
      "properties",
      "items",
      "nullable",
      "description",
      "format",
      "title",
      "example",
      "default",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "minItems",
      "maxItems",
    ],
    label,
  );
  if (schema.nullable === true)
    throw new ContractError(
      `${label} nullable is unsupported; use an explicit oneOf outside this supported subset.`,
    );
  const result: ContractSchema = {};
  if (schema.type !== undefined) {
    if (
      schema.type !== "string" &&
      schema.type !== "number" &&
      schema.type !== "integer" &&
      schema.type !== "boolean" &&
      schema.type !== "array" &&
      schema.type !== "object"
    )
      throw new ContractError(`${label} has unsupported schema type.`);
    result.type = schema.type;
  }
  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.length === 0 ||
      schema.enum.length > 100 ||
      schema.enum.some(
        (entry) =>
          !["string", "number", "boolean"].includes(typeof entry) &&
          entry !== null,
      )
    )
      throw new ContractError(
        `${label} enum must contain 1-100 scalar JSON values.`,
      );
    result.enum = [...schema.enum] as ContractSchema["enum"];
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some(
        (entry) => typeof entry !== "string" || !isFieldName(entry),
      ) ||
      new Set(schema.required).size !== schema.required.length
    )
      throw new ContractError(`${label} required must be unique field names.`);
    result.required = [...schema.required].sort();
  }
  if (schema.properties !== undefined) {
    if (result.type !== "object")
      throw new ContractError(`${label} properties requires type object.`);
    const properties = objectAt(
      schema.properties,
      `${label} properties must be an object.`,
    );
    const entries = Object.entries(properties);
    if (
      entries.length > MAX_PROPERTIES ||
      entries.some(([name]) => !isFieldName(name))
    )
      throw new ContractError(`${label} properties exceed supported limits.`);
    result.properties = Object.fromEntries(
      entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, child]) => [
          name,
          parseOpenApiSchema(child, `${label}.properties.${name}`, depth + 1),
        ]),
    );
  }
  if (schema.items !== undefined) {
    if (result.type !== "array")
      throw new ContractError(`${label} items requires type array.`);
    result.items = parseOpenApiSchema(
      schema.items,
      `${label}.items`,
      depth + 1,
    );
  }
  if (result.type === undefined && result.enum === undefined)
    throw new ContractError(
      `${label} must declare type or enum in the supported subset.`,
    );
  if (result.required !== undefined && result.type !== "object")
    throw new ContractError(`${label} required requires type object.`);
  return result;
}

function assertNoUnsupportedOpenApiFeatures(
  value: Record<string, unknown>,
  label: string,
): void {
  for (const key of [
    "$ref",
    "$dynamicRef",
    "$recursiveRef",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "discriminator",
    "callbacks",
    "links",
    "security",
    "externalDocs",
    "webhooks",
  ]) {
    if (value[key] !== undefined)
      throw new ContractError(
        `${label} uses unsupported OpenAPI feature ${key}. External or recursive references are never fetched or resolved.`,
      );
  }
}

function inferSchema(value: unknown, depth = 0): ContractSchema {
  if (depth > MAX_SCHEMA_DEPTH)
    throw new ContractError(
      `HAR body exceeds schema recursion depth ${MAX_SCHEMA_DEPTH}.`,
    );
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const items =
      value.length === 0
        ? undefined
        : value
            .slice(1)
            .reduce<ContractSchema>(
              (current, entry) =>
                mergeSchemas(current, inferSchema(entry, depth + 1)) ?? {},
              inferSchema(value[0], depth + 1),
            );
    return { type: "array", ...(items === undefined ? {} : { items }) };
  }
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number")
    return { type: Number.isInteger(value) ? "integer" : "number" };
  const entries = Object.entries(
    objectAt(value, "HAR body must be a JSON value."),
  );
  if (entries.length > MAX_PROPERTIES)
    throw new ContractError(
      `HAR body object exceeds ${MAX_PROPERTIES} properties.`,
    );
  return {
    type: "object",
    required: entries.map(([key]) => key).sort(),
    properties: Object.fromEntries(
      entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, inferSchema(entry, depth + 1)]),
    ),
  };
}

function mergeSchemas(
  left: ContractSchema | null | undefined,
  right: ContractSchema | null | undefined,
): ContractSchema | undefined {
  if (left === undefined || left === null) return right ?? undefined;
  if (right === undefined || right === null) return left;
  if (left.type !== right.type) return {};
  const result: ContractSchema = {
    ...(left.type === undefined ? {} : { type: left.type }),
  };
  if (left.enum !== undefined && right.enum !== undefined) {
    const intersection = left.enum.filter((entry) =>
      right.enum!.some(
        (candidate) => stableStringify(candidate) === stableStringify(entry),
      ),
    );
    if (intersection.length > 0) result.enum = intersection;
  }
  if (left.type === "object" && right.type === "object") {
    const leftProperties = left.properties ?? {};
    const rightProperties = right.properties ?? {};
    const common = Object.keys(leftProperties)
      .filter((key) => Object.hasOwn(rightProperties, key))
      .sort();
    result.properties = Object.fromEntries(
      common.map((key) => [
        key,
        mergeSchemas(leftProperties[key], rightProperties[key]) ?? {},
      ]),
    );
    result.required = (left.required ?? [])
      .filter(
        (key) =>
          (right.required ?? []).includes(key) &&
          Object.hasOwn(result.properties ?? {}, key),
      )
      .sort();
  }
  if (left.type === "array")
    result.items = mergeSchemas(left.items, right.items);
  return result;
}

function diffSchema(
  before: ContractSchema | null | undefined,
  after: ContractSchema | null | undefined,
  location: string,
  context: "request" | "response",
  findings: ContractDiffFinding[],
): void {
  if (
    before === undefined ||
    before === null ||
    after === undefined ||
    after === null
  ) {
    if (before !== after)
      findings.push(
        finding(
          "schema-presence-changed",
          location,
          "uncertain",
          `${location} schema presence changed; compatibility cannot be proven.`,
        ),
      );
    return;
  }
  if (before.type !== after.type) {
    findings.push(
      finding(
        "schema-type-changed",
        location,
        "breaking",
        `${location} type changed from ${before.type ?? "unspecified"} to ${after.type ?? "unspecified"}.`,
      ),
    );
    return;
  }
  diffEnum(before.enum, after.enum, location, context, findings);
  const beforeRequired = new Set(before.required ?? []);
  const afterRequired = new Set(after.required ?? []);
  for (const field of [...afterRequired]
    .filter((field) => !beforeRequired.has(field))
    .sort()) {
    findings.push(
      finding(
        "required-field-added",
        `${location}.${field}`,
        context === "request" ? "breaking" : "uncertain",
        `${location} required field added: ${field}.${context === "response" ? " Client response tolerance is unknown." : ""}`,
      ),
    );
  }
  for (const field of [...beforeRequired]
    .filter((field) => !afterRequired.has(field))
    .sort()) {
    findings.push(
      finding(
        "required-field-removed",
        `${location}.${field}`,
        context === "response" ? "breaking" : "non-breaking",
        `${location} required field removed: ${field}.${context === "response" ? " Existing clients may depend on it." : ""}`,
      ),
    );
  }
  const beforeProperties = before.properties ?? {};
  const afterProperties = after.properties ?? {};
  for (const field of Object.keys(beforeProperties)
    .filter((field) => !Object.hasOwn(afterProperties, field))
    .sort())
    findings.push(
      finding(
        "property-removed",
        `${location}.${field}`,
        context === "response" ? "breaking" : "uncertain",
        `${location} property removed: ${field}.${context === "request" ? " Acceptance of this field is not modeled by the supported subset." : ""}`,
      ),
    );
  for (const field of Object.keys(afterProperties)
    .filter((field) => !Object.hasOwn(beforeProperties, field))
    .sort())
    findings.push(
      finding(
        "property-added",
        `${location}.${field}`,
        context === "request" ? "non-breaking" : "uncertain",
        `${location} property added: ${field}.${context === "response" ? " Client response tolerance is unknown." : ""}`,
      ),
    );
  for (const field of Object.keys(beforeProperties)
    .filter((field) => Object.hasOwn(afterProperties, field))
    .sort())
    diffSchema(
      beforeProperties[field],
      afterProperties[field],
      `${location}.${field}`,
      context,
      findings,
    );
  if (before.items !== undefined || after.items !== undefined)
    diffSchema(before.items, after.items, `${location}[]`, context, findings);
}

function diffEnum(
  before: ContractSchema["enum"],
  after: ContractSchema["enum"],
  location: string,
  context: "request" | "response",
  findings: ContractDiffFinding[],
): void {
  if (before === undefined || after === undefined) {
    if (before !== after)
      findings.push(
        finding(
          "enum-presence-changed",
          location,
          "uncertain",
          `${location} enum constraint changed; compatibility cannot be proven.`,
        ),
      );
    return;
  }
  const beforeValues = new Set(before.map(stableStringify));
  const afterValues = new Set(after.map(stableStringify));
  for (const value of [...beforeValues]
    .filter((value) => !afterValues.has(value))
    .sort())
    findings.push(
      finding(
        "enum-value-removed",
        `${location}.${value}`,
        "breaking",
        `${location} enum value removed: ${value}.`,
      ),
    );
  for (const value of [...afterValues]
    .filter((value) => !beforeValues.has(value))
    .sort())
    findings.push(
      finding(
        "enum-value-added",
        `${location}.${value}`,
        context === "request" ? "non-breaking" : "uncertain",
        `${location} enum value added: ${value}.${context === "response" ? " Client handling is unknown." : ""}`,
      ),
    );
}

function diffProviderCapabilities(
  before: ContractProviderCapability[],
  after: ContractProviderCapability[],
  findings: ContractDiffFinding[],
): void {
  const baseline = new Map(before.map((entry) => [entry.name, entry]));
  const candidate = new Map(after.map((entry) => [entry.name, entry]));
  for (const name of [...baseline.keys()].sort()) {
    if (!candidate.has(name))
      findings.push(
        finding(
          "provider-pack-removed",
          name,
          "breaking",
          `Provider pack capability snapshot removed: ${name}.`,
        ),
      );
  }
  for (const name of [...candidate.keys()].sort()) {
    if (!baseline.has(name))
      findings.push(
        finding(
          "provider-pack-added",
          name,
          "non-breaking",
          `Provider pack capability snapshot added: ${name}.`,
        ),
      );
  }
  for (const name of [...baseline.keys()]
    .filter((name) => candidate.has(name))
    .sort()) {
    const left = baseline.get(name)!;
    const right = candidate.get(name)!;
    if (left.packVersion !== right.packVersion)
      findings.push(
        finding(
          "provider-pack-version-changed",
          name,
          "uncertain",
          `Provider pack ${name} version changed from ${left.packVersion ?? "legacy"} to ${right.packVersion ?? "legacy"}; semantic compatibility is not inferred from version text.`,
        ),
      );
    for (const capability of [
      ...new Set([
        ...Object.keys(left.capabilities),
        ...Object.keys(right.capabilities),
      ]),
    ].sort()) {
      const previous = left.capabilities[capability] ?? false;
      const current = right.capabilities[capability] ?? false;
      if (previous === current) continue;
      findings.push(
        finding(
          "provider-capability-changed",
          `${name}.${capability}`,
          current ? "non-breaking" : "breaking",
          `Provider pack ${name} capability ${capability} changed from ${previous} to ${current}.`,
        ),
      );
    }
  }
}

function validateOperation(value: unknown): ContractOperation {
  const operation = objectAt(value, "Contract operation is invalid.");
  assertExactKeys(
    operation,
    ["method", "path", "request", "responses"],
    "Contract operation",
  );
  const method =
    typeof operation.method === "string" && HTTP_METHODS.has(operation.method)
      ? operation.method
      : null;
  if (method === null)
    throw new ContractError("Contract operation method is invalid.");
  validateOpenApiPath(operation.path);
  const responses = objectAt(
    operation.responses,
    "Contract operation responses are invalid.",
  );
  const responseEntries = Object.entries(responses);
  if (responseEntries.length === 0 || responseEntries.length > 20)
    throw new ContractError("Contract operation responses are invalid.");
  return {
    method,
    path: operation.path as string,
    ...(operation.request === undefined
      ? {}
      : {
          request: validateSchema(operation.request, "Contract request schema"),
        }),
    responses: Object.fromEntries(
      responseEntries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, schema]) => {
          if (!/^(?:[1-5][0-9]{2}|default)$/.test(status))
            throw new ContractError("Contract response status is invalid.");
          return [
            status,
            schema === null
              ? null
              : validateSchema(schema, `Contract response ${status} schema`),
          ];
        }),
    ),
  };
}

function validateSchema(
  value: unknown,
  label: string,
  depth = 0,
): ContractSchema {
  if (depth > MAX_SCHEMA_DEPTH)
    throw new ContractError(
      `${label} exceeds schema recursion depth ${MAX_SCHEMA_DEPTH}.`,
    );
  const schema = objectAt(value, `${label} is invalid.`);
  assertExactKeys(
    schema,
    ["type", "enum", "required", "properties", "items"],
    label,
  );
  const result: ContractSchema = {};
  if (schema.type !== undefined) {
    if (
      ![
        "string",
        "number",
        "integer",
        "boolean",
        "array",
        "object",
        "null",
      ].includes(schema.type as string)
    )
      throw new ContractError(`${label} type is invalid.`);
    result.type = schema.type as ContractSchema["type"];
  }
  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.length === 0 ||
      schema.enum.length > 100 ||
      schema.enum.some(
        (entry) =>
          !["string", "number", "boolean"].includes(typeof entry) &&
          entry !== null,
      )
    )
      throw new ContractError(`${label} enum is invalid.`);
    result.enum = [...schema.enum] as ContractSchema["enum"];
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some(
        (entry) => typeof entry !== "string" || !isFieldName(entry),
      ) ||
      new Set(schema.required).size !== schema.required.length
    )
      throw new ContractError(`${label} required is invalid.`);
    result.required = [...schema.required].sort();
  }
  if (schema.properties !== undefined) {
    if (result.type !== "object")
      throw new ContractError(`${label} properties requires type object.`);
    const properties = objectAt(
      schema.properties,
      `${label} properties are invalid.`,
    );
    const entries = Object.entries(properties);
    if (
      entries.length > MAX_PROPERTIES ||
      entries.some(([key]) => !isFieldName(key))
    )
      throw new ContractError(`${label} properties are invalid.`);
    result.properties = Object.fromEntries(
      entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [
          key,
          validateSchema(entry, `${label}.${key}`, depth + 1),
        ]),
    );
  }
  if (schema.items !== undefined) {
    if (result.type !== "array")
      throw new ContractError(`${label} items requires type array.`);
    result.items = validateSchema(schema.items, `${label} items`, depth + 1);
  }
  if (result.type === undefined && result.enum === undefined)
    throw new ContractError(`${label} must declare type or enum.`);
  if (result.required !== undefined && result.type !== "object")
    throw new ContractError(`${label} required requires type object.`);
  return result;
}

function validateCapability(value: unknown): ContractProviderCapability {
  const capability = objectAt(
    value,
    "Contract provider capability is invalid.",
  );
  assertExactKeys(
    capability,
    ["name", "packVersion", "capabilities"],
    "Contract provider capability",
  );
  if (
    typeof capability.name !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(capability.name)
  )
    throw new ContractError("Contract provider capability name is invalid.");
  if (
    capability.packVersion !== null &&
    typeof capability.packVersion !== "string"
  )
    throw new ContractError("Contract provider pack version is invalid.");
  const flags = objectAt(
    capability.capabilities,
    "Contract provider capabilities are invalid.",
  );
  if (
    Object.keys(flags).length > 30 ||
    Object.values(flags).some((value) => typeof value !== "boolean")
  )
    throw new ContractError("Contract provider capabilities are invalid.");
  return {
    name: capability.name,
    packVersion: capability.packVersion,
    capabilities: Object.fromEntries(
      Object.entries(flags).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ) as Record<string, boolean>,
  };
}

function currentProviderCapabilities(): ContractProviderCapability[] {
  return getProviderManifests()
    .map((manifest) => ({
      name: manifest.name,
      packVersion: manifest.packVersion,
      capabilities: Object.fromEntries(
        Object.entries(manifest.capabilities).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function validateOpenApiPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.length > 1_000 ||
    /[\r\n?#{}]/.test(value)
  )
    throw new ContractError(
      "OpenAPI path must be a bounded relative path without query, fragment, path parameters, or line breaks.",
    );
}

function pathWithoutQuery(path: string): string {
  return path.split("?", 1)[0] ?? path;
}

function operationKey(operation: ContractOperation): string {
  return `${operation.method} ${operation.path}`;
}

function compareOperations(
  left: ContractOperation,
  right: ContractOperation,
): number {
  return operationKey(left).localeCompare(operationKey(right));
}

function finding(
  kind: string,
  subject: string,
  severity: ContractDiffSeverity,
  message: string,
): ContractDiffFinding {
  return { id: `${kind}:${subject}`, severity, message };
}

function normalizeTitle(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.trim().length > 120
  )
    throw new ContractError("Contract title must be 1-120 characters.");
  const title = value.trim();
  if (sanitizeSecretString(title) !== title)
    throw new ContractError(
      "Contract title must not contain a secret-shaped value.",
    );
  return title;
}

function isFieldName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\r\n]/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function objectAt(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ContractError(message);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    throw new ContractError(`${label} contains unsupported field: ${unknown}.`);
}

function assertSerializedSize(
  value: unknown,
  label: string,
  limit: number,
): void {
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > limit)
      throw new ContractError(`${label} exceeds ${limit} bytes.`);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError(`${label} must be JSON-serializable.`);
  }
}

async function readBoundedJson(
  path: string,
  projectRoot: string,
  label: string,
  limit = MAX_INPUT_BYTES,
): Promise<unknown> {
  const target = await resolveExistingPath(path, projectRoot, label);
  const source = await readFile(target);
  if (source.byteLength > limit)
    throw new ContractError(`${label} exceeds ${limit} bytes.`);
  if (isArchive(source))
    throw new ContractError(
      `${label} archive input is unsupported; extract one bounded JSON OpenAPI or HAR file first. GhostAPI never decompresses untrusted archives.`,
    );
  try {
    return JSON.parse(source.toString("utf8"));
  } catch {
    throw new ContractError(
      `${label} is not valid JSON. YAML OpenAPI is intentionally unsupported to keep parser resource usage bounded.`,
    );
  }
}

function isArchive(source: Buffer): boolean {
  return (
    (source[0] === 0x50 && source[1] === 0x4b) ||
    (source[0] === 0x1f && source[1] === 0x8b)
  );
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
    throw new ContractError(`${label} must be a regular non-symlink file.`);
  if (!(await isRealPathInsideAllowedRoots(target, projectRoot)))
    throw new ContractError(
      `${label} resolves outside the project root or GHOSTAPI_DATA_DIR through a symlink.`,
    );
  return target;
}

async function resolveOutputPath(
  path: string,
  projectRoot: string,
): Promise<string> {
  const target = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  assertPathInsideAllowedRoots(projectRoot, target, "Contract output");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new ContractError(
      "Contract output parent must be a real directory, not a symlink.",
    );
  if (!(await isRealPathInsideAllowedRoots(dirname(target), projectRoot)))
    throw new ContractError(
      "Contract output parent resolves outside the project root or GHOSTAPI_DATA_DIR through a symlink.",
    );
  const existing = await lstat(target).catch((error: unknown) =>
    isErrorCode(error, "ENOENT") ? null : Promise.reject(error),
  );
  if (existing?.isSymbolicLink())
    throw new ContractError("Contract output path must not be a symlink.");
  return target;
}

function assertPathInsideAllowedRoots(
  projectRoot: string,
  target: string,
  label: string,
): void {
  if (!isInside(projectRoot, target) && !isInside(getDataPaths().root, target))
    throw new ContractError(
      `${label} path traversal outside the project root or GHOSTAPI_DATA_DIR is not allowed.`,
    );
  if (basename(target).trim() === "")
    throw new ContractError(`${label} path must include a file name.`);
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

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "contract"
  );
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
