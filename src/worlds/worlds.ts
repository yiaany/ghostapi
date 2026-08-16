import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataPaths } from "../config/dataPaths.js";
import { isSecretFieldName, sanitizeSecretString } from "../security/secrets.js";
import { atomicWriteJson, ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";

const WORLD_SCHEMA_VERSION = 1;
const WORLD_KIND = "ghostapi.world";
const WORLD_VERSION = "1.0.0";
const MAX_WORLD_BYTES = 512 * 1024;
const MAX_WORKFLOW_RECEIPTS = 100;
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SEED_LENGTH = 128;

export type WorldScenarioReference = {
  id: string;
  version: string;
  seed: string;
};

export type SyntheticWorldManifest = {
  id: string;
  title: string;
  version: string;
  seed: string;
  clock: { initialAt: string; timezone: "UTC" };
  personas: Array<{ id: string; displayName: string; handle: string }>;
  organizations: Array<{ id: string; name: string; slug: string }>;
  accounts: {
    stripe: { accountId: string; customerPrefix: string };
    github: { userLogin: string; owner: string; repository: string };
    email: { domain: string; inboxAddress: string };
    genericRest: { tenantId: string; basePath: string };
  };
  resources: { defaultPriceId: string; recoveryIssueLabel: string };
  relationships: Array<{ personaId: string; organizationId: string; role: "owner" }>;
  providerProjections: {
    stripe: { personaId: string; organizationId: string; customerPrefix: string };
    github: { personaId: string; organizationId: string; repository: string };
    email: { personaId: string; organizationId: string; inboxAddress: string };
    genericRest: { personaId: string; organizationId: string; tenantId: string };
  };
  lineage?: { parentId: string; parentRevision: number };
};

export type WorldWorkflowReceipt = {
  actionId: string;
  customerId: string;
  subscriptionId: string;
  emailId: string;
  issueNumber: number;
  genericFailureId: string;
  completedAt: string;
};

export type SyntheticWorldState = {
  clockAt: string;
  stripe: {
    customers: Array<{ id: string; personaId: string; organizationId: string }>;
    subscriptions: Array<{ id: string; customerId: string; priceId: string; status: "past_due"; failureCode: "card_declined" }>;
  };
  github: { issues: Array<{ number: number; repository: string; title: string; status: "open"; relatedSubscriptionId: string }> };
  email: { messages: Array<{ id: string; to: string; template: "subscription-payment-failed"; relatedSubscriptionId: string }> };
  genericRest: { failures: Array<{ id: string; tenantId: string; code: "payment_failed"; relatedSubscriptionId: string }> };
  receipts: WorldWorkflowReceipt[];
};

export type SyntheticWorld = {
  schemaVersion: 1;
  kind: "ghostapi.world";
  manifest: SyntheticWorldManifest;
  revision: number;
  baseline: SyntheticWorldState;
  state: SyntheticWorldState;
};

export type CreateWorldOptions = {
  id: string;
  seed: string;
  title?: string;
};

export class SyntheticWorldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyntheticWorldError";
  }
}

export function createSyntheticWorld(options: CreateWorldOptions): SyntheticWorld {
  const id = normalizeIdentifier(options.id, "World id");
  const seed = normalizeSeed(options.seed);
  const title = normalizeTitle(options.title ?? `Synthetic world ${id}`);
  const suffix = shortHash(`${id}:${seed}`);
  const personaId = `persona_${suffix}`;
  const organizationId = `org_${suffix}`;
  const slug = `${id}-${suffix}`.slice(0, 63);
  const initialAt = deterministicTimestamp(seed);
  const manifest: SyntheticWorldManifest = {
    id,
    title,
    version: WORLD_VERSION,
    seed,
    clock: { initialAt, timezone: "UTC" },
    personas: [{ id: personaId, displayName: `Operator ${suffix.toUpperCase()}`, handle: `operator-${suffix}` }],
    organizations: [{ id: organizationId, name: `Sandbox ${suffix.toUpperCase()}`, slug }],
    accounts: {
      stripe: { accountId: `acct_world_${suffix}`, customerPrefix: `cus_world_${suffix}` },
      github: { userLogin: `world-${suffix}`, owner: `sandbox-${suffix}`, repository: `integration-${suffix}` },
      email: { domain: "ghostapi.invalid", inboxAddress: `operator-${suffix}@ghostapi.invalid` },
      genericRest: { tenantId: `tenant_world_${suffix}`, basePath: `/tenants/tenant_world_${suffix}` }
    },
    resources: { defaultPriceId: `price_world_${suffix}`, recoveryIssueLabel: "payment-recovery" },
    relationships: [{ personaId, organizationId, role: "owner" }],
    providerProjections: {
      stripe: { personaId, organizationId, customerPrefix: `cus_world_${suffix}` },
      github: { personaId, organizationId, repository: `sandbox-${suffix}/integration-${suffix}` },
      email: { personaId, organizationId, inboxAddress: `operator-${suffix}@ghostapi.invalid` },
      genericRest: { personaId, organizationId, tenantId: `tenant_world_${suffix}` }
    }
  };
  const initialState: SyntheticWorldState = {
    clockAt: initialAt,
    stripe: { customers: [], subscriptions: [] },
    github: { issues: [] },
    email: { messages: [] },
    genericRest: { failures: [] },
    receipts: []
  };
  return validateSyntheticWorld({ schemaVersion: WORLD_SCHEMA_VERSION, kind: WORLD_KIND, manifest, revision: 0, baseline: initialState, state: initialState });
}

export async function createWorld(options: CreateWorldOptions): Promise<SyntheticWorld> {
  const world = createSyntheticWorld(options);
  const path = getWorldPath(world.manifest.id);
  await withFileLock(path, async () => {
    await ensureWorldFileIsSafe(path, false);
    const existing = await lstat(path).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
    if (existing !== null) throw new SyntheticWorldError(`Synthetic world already exists: ${world.manifest.id}`);
    await atomicWriteJson(path, world);
  });
  return world;
}

export async function inspectWorld(id: string): Promise<SyntheticWorld> {
  return readWorld(normalizeIdentifier(id, "World id"));
}

export async function resetWorld(id: string): Promise<SyntheticWorld> {
  return mutateWorld(normalizeIdentifier(id, "World id"), (world) => ({
    ...world,
    revision: world.revision + 1,
    state: structuredClone(world.baseline)
  }));
}

export async function forkWorld(sourceId: string, options: { id: string; title?: string }): Promise<SyntheticWorld> {
  const source = await readWorld(normalizeIdentifier(sourceId, "Source world id"));
  const id = normalizeIdentifier(options.id, "Fork world id");
  const title = normalizeTitle(options.title ?? `${source.manifest.title} fork`);
  const path = getWorldPath(id);
  const fork = structuredClone(source);
  fork.manifest.id = id;
  fork.manifest.title = title;
  fork.manifest.lineage = { parentId: source.manifest.id, parentRevision: source.revision };
  fork.revision = 0;
  fork.baseline = structuredClone(source.state);
  fork.state = structuredClone(source.state);
  const valid = validateSyntheticWorld(fork);
  await withFileLock(path, async () => {
    await ensureWorldFileIsSafe(path, false);
    const existing = await lstat(path).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
    if (existing !== null) throw new SyntheticWorldError(`Synthetic world already exists: ${id}`);
    await atomicWriteJson(path, valid);
  });
  return valid;
}

export async function runSubscriptionFailureWorkflow(id: string, actionId: string, commit?: <T>(operation: () => Promise<T>) => Promise<T>): Promise<WorldWorkflowReceipt> {
  const normalizedActionId = normalizeIdentifier(actionId, "Workflow action id");
  let receipt: WorldWorkflowReceipt | undefined;
  await mutateWorld(normalizeIdentifier(id, "World id"), (world) => {
    const existing = world.state.receipts.find((candidate) => candidate.actionId === normalizedActionId);
    if (existing !== undefined) {
      receipt = existing;
      return world;
    }
    if (world.state.receipts.length >= MAX_WORKFLOW_RECEIPTS) throw new SyntheticWorldError(`Synthetic world permits at most ${MAX_WORKFLOW_RECEIPTS} workflow receipts.`);

    const suffix = shortHash(`${world.manifest.seed}:${normalizedActionId}`);
    const persona = world.manifest.personas[0]!;
    const organization = world.manifest.organizations[0]!;
    const customerId = `${world.manifest.accounts.stripe.customerPrefix}_${suffix}`;
    const subscriptionId = `sub_world_${suffix}`;
    const emailId = `email_world_${suffix}`;
    const genericFailureId = `failure_world_${suffix}`;
    receipt = {
      actionId: normalizedActionId,
      customerId,
      subscriptionId,
      emailId,
      issueNumber: world.state.github.issues.length + 1,
      genericFailureId,
      completedAt: nextTimestamp(world.state.clockAt)
    };
    const nextState: SyntheticWorldState = {
      clockAt: receipt.completedAt,
      stripe: {
        customers: [...world.state.stripe.customers, { id: customerId, personaId: persona.id, organizationId: organization.id }],
        subscriptions: [...world.state.stripe.subscriptions, { id: subscriptionId, customerId, priceId: world.manifest.resources.defaultPriceId, status: "past_due", failureCode: "card_declined" }]
      },
      github: { issues: [...world.state.github.issues, { number: receipt.issueNumber, repository: world.manifest.providerProjections.github.repository, title: `Recover ${subscriptionId}`, status: "open", relatedSubscriptionId: subscriptionId }] },
      email: { messages: [...world.state.email.messages, { id: emailId, to: world.manifest.accounts.email.inboxAddress, template: "subscription-payment-failed", relatedSubscriptionId: subscriptionId }] },
      genericRest: { failures: [...world.state.genericRest.failures, { id: genericFailureId, tenantId: world.manifest.accounts.genericRest.tenantId, code: "payment_failed", relatedSubscriptionId: subscriptionId }] },
      receipts: [...world.state.receipts, receipt]
    };
    return { ...world, revision: world.revision + 1, state: nextState };
  }, commit);
  if (receipt === undefined) throw new SyntheticWorldError("World workflow did not produce a receipt.");
  return receipt;
}

export function getWorldPath(id: string): string {
  return join(getDataPaths().worlds, `${normalizeIdentifier(id, "World id")}.world.json`);
}

export function formatWorld(world: SyntheticWorld): string {
  return [
    `GhostAPI synthetic world: ${world.manifest.id}`,
    `Title: ${world.manifest.title}`,
    `Version: ${world.manifest.version}`,
    `Seed: ${world.manifest.seed}`,
    `Revision: ${world.revision}`,
    `Persona: ${world.manifest.personas[0]!.id}`,
    `Organization: ${world.manifest.organizations[0]!.id}`,
    `Providers: stripe, github, email, generic-rest`,
    `Workflow receipts: ${world.state.receipts.length}`
  ].join("\n");
}

export function validateSyntheticWorld(value: unknown): SyntheticWorld {
  const root = readObject(value, "Synthetic world must be an object.");
  assertExactKeys(root, ["schemaVersion", "kind", "manifest", "revision", "baseline", "state"], "Synthetic world");
  if (root.schemaVersion !== WORLD_SCHEMA_VERSION || root.kind !== WORLD_KIND) throw new SyntheticWorldError("Unsupported synthetic world schema.");
  if (!Number.isInteger(root.revision) || (root.revision as number) < 0 || (root.revision as number) > 1_000_000) throw new SyntheticWorldError("Synthetic world revision is invalid.");
  const manifest = normalizeManifest(root.manifest);
  const baseline = normalizeState(root.baseline, manifest);
  const state = normalizeState(root.state, manifest);
  const world: SyntheticWorld = { schemaVersion: 1, kind: "ghostapi.world", manifest, revision: root.revision as number, baseline, state };
  assertWorldSize(world);
  return world;
}

async function readWorld(id: string): Promise<SyntheticWorld> {
  const path = getWorldPath(id);
  await ensureWorldFileIsSafe(path, true);
  const source = await readFile(path, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_WORLD_BYTES) throw new SyntheticWorldError(`Synthetic world exceeds ${MAX_WORLD_BYTES} bytes.`);
  try {
    const world = validateSyntheticWorld(JSON.parse(source));
    if (world.manifest.id !== id) throw new SyntheticWorldError("Synthetic world manifest id does not match its file identity.");
    return world;
  } catch (error) {
    if (error instanceof SyntheticWorldError) throw error;
    throw new SyntheticWorldError("Synthetic world is not valid JSON.");
  }
}

async function mutateWorld(id: string, mutation: (world: SyntheticWorld) => SyntheticWorld | Promise<SyntheticWorld>, commit?: <T>(operation: () => Promise<T>) => Promise<T>): Promise<SyntheticWorld> {
  const path = getWorldPath(id);
  return withFileLock(path, async () => {
    const current = await readWorld(id);
    const next = validateSyntheticWorld(await mutation(structuredClone(current)));
    const write = () => atomicWriteJson(path, next);
    if (commit === undefined) await write();
    else await commit(write);
    return next;
  });
}

async function ensureWorldFileIsSafe(path: string, required: boolean): Promise<void> {
  await ensurePrivateDirectory(getDataPaths().worlds);
  const info = await lstat(path).catch((error: unknown) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
  if (info === null) {
    if (required) throw new SyntheticWorldError(`Synthetic world was not found: ${path}`);
    return;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new SyntheticWorldError("Synthetic world must be a regular non-symlink file.");
}

function normalizeManifest(value: unknown): SyntheticWorldManifest {
  const manifest = readObject(value, "Synthetic world manifest is invalid.");
  assertExactKeys(manifest, ["id", "title", "version", "seed", "clock", "personas", "organizations", "accounts", "resources", "relationships", "providerProjections", "lineage"], "Synthetic world manifest");
  const id = normalizeIdentifier(manifest.id, "World id");
  const title = normalizeTitle(manifest.title);
  if (manifest.version !== WORLD_VERSION) throw new SyntheticWorldError(`Unsupported synthetic world version: ${String(manifest.version)}`);
  const seed = normalizeSeed(manifest.seed);
  const clock = readObject(manifest.clock, "Synthetic world clock is invalid.");
  assertExactKeys(clock, ["initialAt", "timezone"], "Synthetic world clock");
  if (!isTimestamp(clock.initialAt) || clock.timezone !== "UTC") throw new SyntheticWorldError("Synthetic world clock is invalid.");
  const personas = normalizePersonas(manifest.personas);
  const organizations = normalizeOrganizations(manifest.organizations);
  const accounts = normalizeAccounts(manifest.accounts);
  const resources = normalizeResources(manifest.resources);
  const relationships = normalizeRelationships(manifest.relationships, personas[0]!.id, organizations[0]!.id);
  const providerProjections = normalizeProjections(manifest.providerProjections, personas[0]!.id, organizations[0]!.id, accounts);
  const lineage = manifest.lineage === undefined ? undefined : normalizeLineage(manifest.lineage);
  return { id, title, version: WORLD_VERSION, seed, clock: { initialAt: clock.initialAt as string, timezone: "UTC" }, personas, organizations, accounts, resources, relationships, providerProjections, ...(lineage === undefined ? {} : { lineage }) };
}

function normalizePersonas(value: unknown): SyntheticWorldManifest["personas"] {
  if (!Array.isArray(value) || value.length !== 1) throw new SyntheticWorldError("Synthetic world requires exactly one synthetic persona.");
  const persona = readObject(value[0], "Synthetic persona is invalid.");
  assertExactKeys(persona, ["id", "displayName", "handle"], "Synthetic persona");
  return [{ id: normalizeIdentifier(persona.id, "Synthetic persona id"), displayName: normalizeSafeText(persona.displayName, "Synthetic persona displayName", 80), handle: normalizeIdentifier(persona.handle, "Synthetic persona handle") }];
}

function normalizeOrganizations(value: unknown): SyntheticWorldManifest["organizations"] {
  if (!Array.isArray(value) || value.length !== 1) throw new SyntheticWorldError("Synthetic world requires exactly one synthetic organization.");
  const organization = readObject(value[0], "Synthetic organization is invalid.");
  assertExactKeys(organization, ["id", "name", "slug"], "Synthetic organization");
  return [{ id: normalizeIdentifier(organization.id, "Synthetic organization id"), name: normalizeSafeText(organization.name, "Synthetic organization name", 80), slug: normalizeIdentifier(organization.slug, "Synthetic organization slug") }];
}

function normalizeAccounts(value: unknown): SyntheticWorldManifest["accounts"] {
  const accounts = readObject(value, "Synthetic world accounts are invalid.");
  assertExactKeys(accounts, ["stripe", "github", "email", "genericRest"], "Synthetic world accounts");
  const stripe = readObject(accounts.stripe, "Synthetic Stripe account is invalid.");
  const github = readObject(accounts.github, "Synthetic GitHub account is invalid.");
  const email = readObject(accounts.email, "Synthetic email account is invalid.");
  const genericRest = readObject(accounts.genericRest, "Synthetic generic REST account is invalid.");
  assertExactKeys(stripe, ["accountId", "customerPrefix"], "Synthetic Stripe account");
  assertExactKeys(github, ["userLogin", "owner", "repository"], "Synthetic GitHub account");
  assertExactKeys(email, ["domain", "inboxAddress"], "Synthetic email account");
  assertExactKeys(genericRest, ["tenantId", "basePath"], "Synthetic generic REST account");
  const domain = normalizeSafeText(email.domain, "Synthetic email domain", 120);
  const inboxAddress = normalizeSyntheticInboxAddress(email.inboxAddress);
  if (domain !== "ghostapi.invalid") throw new SyntheticWorldError("Synthetic world email addresses must use ghostapi.invalid.");
  return {
    stripe: { accountId: normalizeIdentifier(stripe.accountId, "Synthetic Stripe account id"), customerPrefix: normalizeIdentifier(stripe.customerPrefix, "Synthetic Stripe customer prefix") },
    github: { userLogin: normalizeIdentifier(github.userLogin, "Synthetic GitHub login"), owner: normalizeIdentifier(github.owner, "Synthetic GitHub owner"), repository: normalizeIdentifier(github.repository, "Synthetic GitHub repository") },
    email: { domain, inboxAddress },
    genericRest: { tenantId: normalizeIdentifier(genericRest.tenantId, "Synthetic tenant id"), basePath: normalizeBasePath(genericRest.basePath) }
  };
}

function normalizeResources(value: unknown): SyntheticWorldManifest["resources"] {
  const resources = readObject(value, "Synthetic world resources are invalid.");
  assertExactKeys(resources, ["defaultPriceId", "recoveryIssueLabel"], "Synthetic world resources");
  return { defaultPriceId: normalizeIdentifier(resources.defaultPriceId, "Synthetic price id"), recoveryIssueLabel: normalizeIdentifier(resources.recoveryIssueLabel, "Synthetic issue label") };
}

function normalizeRelationships(value: unknown, personaId: string, organizationId: string): SyntheticWorldManifest["relationships"] {
  if (!Array.isArray(value) || value.length !== 1) throw new SyntheticWorldError("Synthetic world requires one persona-to-organization relationship.");
  const relationship = readObject(value[0], "Synthetic world relationship is invalid.");
  assertExactKeys(relationship, ["personaId", "organizationId", "role"], "Synthetic world relationship");
  if (relationship.personaId !== personaId || relationship.organizationId !== organizationId || relationship.role !== "owner") throw new SyntheticWorldError("Synthetic world relationship does not match canonical identity.");
  return [{ personaId, organizationId, role: "owner" }];
}

function normalizeProjections(value: unknown, personaId: string, organizationId: string, accounts: SyntheticWorldManifest["accounts"]): SyntheticWorldManifest["providerProjections"] {
  const projections = readObject(value, "Synthetic world provider projections are invalid.");
  assertExactKeys(projections, ["stripe", "github", "email", "genericRest"], "Synthetic world provider projections");
  const stripe = readObject(projections.stripe, "Synthetic Stripe projection is invalid.");
  const github = readObject(projections.github, "Synthetic GitHub projection is invalid.");
  const email = readObject(projections.email, "Synthetic email projection is invalid.");
  const genericRest = readObject(projections.genericRest, "Synthetic generic REST projection is invalid.");
  assertExactKeys(stripe, ["personaId", "organizationId", "customerPrefix"], "Synthetic Stripe projection");
  assertExactKeys(github, ["personaId", "organizationId", "repository"], "Synthetic GitHub projection");
  assertExactKeys(email, ["personaId", "organizationId", "inboxAddress"], "Synthetic email projection");
  assertExactKeys(genericRest, ["personaId", "organizationId", "tenantId"], "Synthetic generic REST projection");
  if (stripe.personaId !== personaId || stripe.organizationId !== organizationId || stripe.customerPrefix !== accounts.stripe.customerPrefix || github.personaId !== personaId || github.organizationId !== organizationId || github.repository !== `${accounts.github.owner}/${accounts.github.repository}` || email.personaId !== personaId || email.organizationId !== organizationId || email.inboxAddress !== accounts.email.inboxAddress || genericRest.personaId !== personaId || genericRest.organizationId !== organizationId || genericRest.tenantId !== accounts.genericRest.tenantId) {
    throw new SyntheticWorldError("Provider projections do not match canonical synthetic identity.");
  }
  return { stripe: { personaId, organizationId, customerPrefix: accounts.stripe.customerPrefix }, github: { personaId, organizationId, repository: `${accounts.github.owner}/${accounts.github.repository}` }, email: { personaId, organizationId, inboxAddress: accounts.email.inboxAddress }, genericRest: { personaId, organizationId, tenantId: accounts.genericRest.tenantId } };
}

function normalizeLineage(value: unknown): NonNullable<SyntheticWorldManifest["lineage"]> {
  const lineage = readObject(value, "Synthetic world lineage is invalid.");
  assertExactKeys(lineage, ["parentId", "parentRevision"], "Synthetic world lineage");
  if (!Number.isInteger(lineage.parentRevision) || (lineage.parentRevision as number) < 0) throw new SyntheticWorldError("Synthetic world lineage revision is invalid.");
  return { parentId: normalizeIdentifier(lineage.parentId, "Synthetic world parent id"), parentRevision: lineage.parentRevision as number };
}

function normalizeState(value: unknown, manifest: SyntheticWorldManifest): SyntheticWorldState {
  const state = readObject(value, "Synthetic world state is invalid.");
  assertExactKeys(state, ["clockAt", "stripe", "github", "email", "genericRest", "receipts"], "Synthetic world state");
  if (!isTimestamp(state.clockAt) || state.clockAt < manifest.clock.initialAt) throw new SyntheticWorldError("Synthetic world state clock is invalid.");
  const stripe = readObject(state.stripe, "Synthetic Stripe state is invalid.");
  const github = readObject(state.github, "Synthetic GitHub state is invalid.");
  const email = readObject(state.email, "Synthetic email state is invalid.");
  const genericRest = readObject(state.genericRest, "Synthetic generic REST state is invalid.");
  assertExactKeys(stripe, ["customers", "subscriptions"], "Synthetic Stripe state");
  assertExactKeys(github, ["issues"], "Synthetic GitHub state");
  assertExactKeys(email, ["messages"], "Synthetic email state");
  assertExactKeys(genericRest, ["failures"], "Synthetic generic REST state");
  const customers = normalizeCustomers(stripe.customers, manifest);
  const subscriptions = normalizeSubscriptions(stripe.subscriptions, customers, manifest);
  const issues = normalizeIssues(github.issues, subscriptions, manifest);
  const messages = normalizeMessages(email.messages, subscriptions, manifest);
  const failures = normalizeFailures(genericRest.failures, subscriptions, manifest);
  const receipts = normalizeReceipts(state.receipts, customers, subscriptions, messages, issues, failures, manifest);
  if (customers.length !== subscriptions.length || customers.length !== issues.length || customers.length !== messages.length || customers.length !== failures.length || customers.length !== receipts.length) throw new SyntheticWorldError("Synthetic world providers have inconsistent workflow state.");
  if (new Set(customers.map((customer) => customer.id)).size !== customers.length || new Set(subscriptions.map((subscription) => subscription.id)).size !== subscriptions.length || new Set(messages.map((message) => message.id)).size !== messages.length || new Set(issues.map((issue) => issue.number)).size !== issues.length || new Set(failures.map((failure) => failure.id)).size !== failures.length) {
    throw new SyntheticWorldError("Synthetic world contains duplicate provider resources.");
  }
  const subscriptionsById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const issuesByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const failuresById = new Map(failures.map((failure) => [failure.id, failure]));
  for (const receipt of receipts) {
    const subscription = subscriptionsById.get(receipt.subscriptionId);
    if (subscription?.customerId !== receipt.customerId || messagesById.get(receipt.emailId)?.relatedSubscriptionId !== receipt.subscriptionId || issuesByNumber.get(receipt.issueNumber)?.relatedSubscriptionId !== receipt.subscriptionId || failuresById.get(receipt.genericFailureId)?.relatedSubscriptionId !== receipt.subscriptionId) {
      throw new SyntheticWorldError("Synthetic workflow receipt does not link one consistent cross-provider transition.");
    }
  }
  return { clockAt: state.clockAt as string, stripe: { customers, subscriptions }, github: { issues }, email: { messages }, genericRest: { failures }, receipts };
}

function normalizeCustomers(value: unknown, manifest: SyntheticWorldManifest): SyntheticWorldState["stripe"]["customers"] {
  return readArray(value, "Synthetic Stripe customers", MAX_WORKFLOW_RECEIPTS).map((entry) => {
    const customer = readObject(entry, "Synthetic Stripe customer is invalid.");
    assertExactKeys(customer, ["id", "personaId", "organizationId"], "Synthetic Stripe customer");
    if (customer.personaId !== manifest.personas[0]!.id || customer.organizationId !== manifest.organizations[0]!.id) throw new SyntheticWorldError("Synthetic Stripe customer identity is inconsistent.");
    return { id: normalizeIdentifier(customer.id, "Synthetic Stripe customer id"), personaId: manifest.personas[0]!.id, organizationId: manifest.organizations[0]!.id };
  });
}

function normalizeSubscriptions(value: unknown, customers: SyntheticWorldState["stripe"]["customers"], manifest: SyntheticWorldManifest): SyntheticWorldState["stripe"]["subscriptions"] {
  const customerIds = new Set(customers.map((customer) => customer.id));
  return readArray(value, "Synthetic Stripe subscriptions", MAX_WORKFLOW_RECEIPTS).map((entry) => {
    const subscription = readObject(entry, "Synthetic Stripe subscription is invalid.");
    assertExactKeys(subscription, ["id", "customerId", "priceId", "status", "failureCode"], "Synthetic Stripe subscription");
    if (!customerIds.has(subscription.customerId as string) || subscription.priceId !== manifest.resources.defaultPriceId || subscription.status !== "past_due" || subscription.failureCode !== "card_declined") throw new SyntheticWorldError("Synthetic Stripe subscription is inconsistent.");
    return { id: normalizeIdentifier(subscription.id, "Synthetic Stripe subscription id"), customerId: subscription.customerId as string, priceId: manifest.resources.defaultPriceId, status: "past_due", failureCode: "card_declined" };
  });
}

function normalizeIssues(value: unknown, subscriptions: SyntheticWorldState["stripe"]["subscriptions"], manifest: SyntheticWorldManifest): SyntheticWorldState["github"]["issues"] {
  const subscriptionsById = new Set(subscriptions.map((subscription) => subscription.id));
  return readArray(value, "Synthetic GitHub issues", MAX_WORKFLOW_RECEIPTS).map((entry) => {
    const issue = readObject(entry, "Synthetic GitHub issue is invalid.");
    assertExactKeys(issue, ["number", "repository", "title", "status", "relatedSubscriptionId"], "Synthetic GitHub issue");
    if (!Number.isInteger(issue.number) || (issue.number as number) < 1 || issue.repository !== manifest.providerProjections.github.repository || typeof issue.title !== "string" || issue.status !== "open" || !subscriptionsById.has(issue.relatedSubscriptionId as string)) throw new SyntheticWorldError("Synthetic GitHub issue is inconsistent.");
    return { number: issue.number as number, repository: manifest.providerProjections.github.repository, title: normalizeSafeText(issue.title, "Synthetic GitHub issue title", 160), status: "open", relatedSubscriptionId: issue.relatedSubscriptionId as string };
  });
}

function normalizeMessages(value: unknown, subscriptions: SyntheticWorldState["stripe"]["subscriptions"], manifest: SyntheticWorldManifest): SyntheticWorldState["email"]["messages"] {
  const subscriptionsById = new Set(subscriptions.map((subscription) => subscription.id));
  return readArray(value, "Synthetic email messages", MAX_WORKFLOW_RECEIPTS).map((entry) => {
    const message = readObject(entry, "Synthetic email message is invalid.");
    assertExactKeys(message, ["id", "to", "template", "relatedSubscriptionId"], "Synthetic email message");
    if (message.to !== manifest.accounts.email.inboxAddress || message.template !== "subscription-payment-failed" || !subscriptionsById.has(message.relatedSubscriptionId as string)) throw new SyntheticWorldError("Synthetic email message is inconsistent.");
    return { id: normalizeIdentifier(message.id, "Synthetic email message id"), to: manifest.accounts.email.inboxAddress, template: "subscription-payment-failed", relatedSubscriptionId: message.relatedSubscriptionId as string };
  });
}

function normalizeFailures(value: unknown, subscriptions: SyntheticWorldState["stripe"]["subscriptions"], manifest: SyntheticWorldManifest): SyntheticWorldState["genericRest"]["failures"] {
  const subscriptionsById = new Set(subscriptions.map((subscription) => subscription.id));
  return readArray(value, "Synthetic generic REST failures", MAX_WORKFLOW_RECEIPTS).map((entry) => {
    const failure = readObject(entry, "Synthetic generic REST failure is invalid.");
    assertExactKeys(failure, ["id", "tenantId", "code", "relatedSubscriptionId"], "Synthetic generic REST failure");
    if (failure.tenantId !== manifest.accounts.genericRest.tenantId || failure.code !== "payment_failed" || !subscriptionsById.has(failure.relatedSubscriptionId as string)) throw new SyntheticWorldError("Synthetic generic REST failure is inconsistent.");
    return { id: normalizeIdentifier(failure.id, "Synthetic generic REST failure id"), tenantId: manifest.accounts.genericRest.tenantId, code: "payment_failed", relatedSubscriptionId: failure.relatedSubscriptionId as string };
  });
}

function normalizeReceipts(value: unknown, customers: SyntheticWorldState["stripe"]["customers"], subscriptions: SyntheticWorldState["stripe"]["subscriptions"], messages: SyntheticWorldState["email"]["messages"], issues: SyntheticWorldState["github"]["issues"], failures: SyntheticWorldState["genericRest"]["failures"], manifest: SyntheticWorldManifest): WorldWorkflowReceipt[] {
  const customerIds = new Set(customers.map((customer) => customer.id));
  const subscriptionIds = new Set(subscriptions.map((subscription) => subscription.id));
  const messageIds = new Set(messages.map((message) => message.id));
  const issueNumbers = new Set(issues.map((issue) => issue.number));
  const failureIds = new Set(failures.map((failure) => failure.id));
  const actionIds = new Set<string>();
  return readArray(value, "Synthetic workflow receipts", MAX_WORKFLOW_RECEIPTS).map((entry) => {
    const receipt = readObject(entry, "Synthetic workflow receipt is invalid.");
    assertExactKeys(receipt, ["actionId", "customerId", "subscriptionId", "emailId", "issueNumber", "genericFailureId", "completedAt"], "Synthetic workflow receipt");
    const actionId = normalizeIdentifier(receipt.actionId, "Synthetic workflow action id");
    if (actionIds.has(actionId) || !customerIds.has(receipt.customerId as string) || !subscriptionIds.has(receipt.subscriptionId as string) || !messageIds.has(receipt.emailId as string) || !issueNumbers.has(receipt.issueNumber as number) || !failureIds.has(receipt.genericFailureId as string) || !isTimestamp(receipt.completedAt) || (receipt.completedAt as string) < manifest.clock.initialAt) throw new SyntheticWorldError("Synthetic workflow receipt is inconsistent.");
    actionIds.add(actionId);
    return { actionId, customerId: receipt.customerId as string, subscriptionId: receipt.subscriptionId as string, emailId: receipt.emailId as string, issueNumber: receipt.issueNumber as number, genericFailureId: receipt.genericFailureId as string, completedAt: receipt.completedAt as string };
  });
}

function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || sanitizeSecretString(value) !== value) throw new SyntheticWorldError(`${label} must be a safe stable identifier.`);
  return value;
}

function normalizeSeed(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_SEED_LENGTH || /[\r\n\t]/.test(value) || sanitizeSecretString(value) !== value || hasObviousPii(value)) throw new SyntheticWorldError("World seed must be a non-secret, non-PII 1-128 character string.");
  return value;
}

function normalizeTitle(value: unknown): string {
  return normalizeSafeText(value, "World title", 120);
}

function normalizeSafeText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > maximumLength || /[\r\n\t]/.test(value) || sanitizeSecretString(value) !== value || hasObviousPii(value)) throw new SyntheticWorldError(`${label} must be safe non-PII plain text.`);
  return value.trim();
}

function normalizeBasePath(value: unknown): string {
  if (typeof value !== "string" || !/^\/tenants\/[a-z0-9_-]+$/.test(value)) throw new SyntheticWorldError("Synthetic generic REST base path is invalid.");
  return value;
}

function normalizeSyntheticInboxAddress(value: unknown): string {
  if (typeof value !== "string" || !/^operator-[a-f0-9]{12}@ghostapi\.invalid$/.test(value)) throw new SyntheticWorldError("Synthetic inbox address must use the generated ghostapi.invalid format.");
  return value;
}

function readArray(value: unknown, label: string, maximumLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) throw new SyntheticWorldError(`${label} must be a bounded array.`);
  return value;
}

function readObject(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SyntheticWorldError(message);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new SyntheticWorldError(`${label} contains unknown field: ${unknown}`);
  const sensitive = Object.keys(value).find(isSecretFieldName);
  if (sensitive !== undefined) throw new SyntheticWorldError(`${label} contains secret-shaped field: ${sensitive}`);
}

function assertWorldSize(world: SyntheticWorld): void {
  const serialized = JSON.stringify(world);
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORLD_BYTES) throw new SyntheticWorldError(`Synthetic world exceeds ${MAX_WORLD_BYTES} bytes.`);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function deterministicTimestamp(seed: string): string {
  const seconds = Number.parseInt(shortHash(seed).slice(0, 8), 16) % (365 * 24 * 60 * 60);
  return new Date(Date.UTC(2024, 0, 1) + seconds * 1000).toISOString();
}

function nextTimestamp(value: string): string {
  return new Date(Date.parse(value) + 1000).toISOString();
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function hasObviousPii(value: string): boolean {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) || /(?:\+\d[\d(). -]{7,}\d|\b\d{3}[ .-]\d{3}[ .-]\d{4}\b)/.test(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
