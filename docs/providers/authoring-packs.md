# Authoring Provider Packs

Provider packs are the versioned contract layer for provider-specific behavior in GhostAPI. Resend and Stripe are migrated built-in packs. Twilio, GitHub, Discord, and OpenAI remain on the legacy adapter path until they can be migrated in small reviewed changes. Generic REST remains the fallback.

## Scope And Trust Boundary

Provider packs are built-in TypeScript modules compiled with GhostAPI. GhostAPI does not load uploaded, downloaded, or third-party executable provider code.

A pack receives only explicit inputs:

- detection receives a normalized path only;
- parsing, validation, and handling receive the sanitized `NormalizedRequest`;
- clock, ID generation, and a read-only state snapshot require explicit runtime capabilities;
- no network, filesystem, environment, or secret capability is available to a pack.

The source regression test rejects pack modules that import Node network/filesystem modules or access `process.env` or `fetch`. This is a maintenance boundary, not a secure JavaScript sandbox. Do not advertise arbitrary plugin isolation.

## Public Interfaces

The stable authoring surface is exported from `src/index.ts`:

- `ProviderPack`;
- `ProviderPackManifest`;
- `ProviderConformanceFixture`;
- `ProviderRuntime` and `ProviderRuntimeCapabilities`;
- `ProviderScenario` and `ProviderScenarioStep`;
- `ProviderWebhookHook`;
- `createProviderRuntime()`;
- `runProviderPackConformance()`.

The request pipeline, registry lookup, prepared execution object, response headers, state persistence, cache, Fault Lab, dashboard events, and scenario persistence are internal interfaces. Packs must not import stores or server modules directly.

## Required Contract

Every pack declares:

```ts
export const examplePack: ProviderPack = {
  name: "example",
  displayName: "Example",
  manifest: {
    schemaVersion: 1,
    name: "example",
    displayName: "Example",
    implementation: "pack",
    packVersion: "1.0.0",
    apiVersions: { default: "v1", supported: ["v1"] },
    capabilities: {
      detection: true,
      requestParsing: true,
      validation: true,
      deterministicResponses: true,
      stateTransitions: true,
      providerErrors: true,
      scenarios: false,
      webhooks: false,
      conformanceFixtures: true,
    },
  },
  detection: {
    priority: 100,
    matches: ({ path }) => path.startsWith("/example"),
  },
  parseRequest: (request) => request.body,
  selectApiVersion: () => ({ version: "v1" }),
  validate: () => null,
  handleDeterministic: ({ runtime }) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      id: runtime.requireCapability("idGenerator").create("example_mock"),
    },
  }),
  createResponseHeaders: () => ({}),
  transitionState: () => null,
  stateful: false,
  formatError: (details) => ({ error: { message: details.message } }),
  promptHints: [],
  scenarios: [],
  conformanceFixtures: [],
};
```

The manifest is returned by `GET /api/providers`, shown in dashboard provider filters, and printed by `ghostapi providers list` and `ghostapi providers inspect <name>`.

## API Version Selection

Pack API versions are GhostAPI compatibility versions, not an automatic claim of full parity with a provider's live API. A pack must:

1. declare one default version and all supported versions;
2. select a version before request validation;
3. return a provider-shaped `ProviderErrorDetails` for unsupported explicit versions;
4. include version-sensitive request headers in cache identity;
5. change `packVersion` when pack behavior changes and add a new API version when the simulated contract changes incompatibly.

The Resend pack accepts `x-ghostapi-api-version: v1`. Successful responses include:

```text
x-ghostapi-provider-pack: resend@1.0.0
x-ghostapi-api-version: v1
```

## Determinism

Do not call `Date.now()`, `new Date()`, random generators, environment variables, or external services inside a pack. Request runtime capabilities explicitly:

```ts
const now = runtime.requireCapability("clock").now();
const id = runtime.requireCapability("idGenerator").create("item_mock");
```

Tests must inject fixed implementations with `createProviderRuntime()`. `createResponseHeaders()` can add deterministic provider headers such as Stripe request IDs to successful or early-error responses. Asking for an undeclared capability fails with `Unknown provider capability: <name>`.

## Validation And Errors

`parseRequest()` converts the sanitized normalized request into the provider's internal request shape. `validate()` returns `null` or `ProviderErrorDetails`. Core formats the details through the registered provider error formatter.

Keep validation order stable when migrating a public route. Error status, field names, messages, and provider shape are observable behavior.

## State Transitions

`transitionState()` describes persistence but does not write it. Core owns storage and requires keys to stay in the exact `<provider>:<id>` namespace. A pack that declares `stateful: true` executes under one atomic local-state transaction and can inspect the injected read-only snapshot while deciding its response. It still cannot access a store directly.

A transition must be derived from the handled response and must not read ambient state. The conformance fixture should assert both the key and value. Core rejects cross-provider or empty keys before persistence.

## Scenarios And Webhooks

Pack scenarios use the shared `ProviderScenario` shape and are merged into the existing scenario registry. Scenario replay still installs deterministic method/path behaviors and runs before faults, validation, state, cache, and generation.

`ProviderWebhookHook` is part of the authoring vocabulary, but no built-in pack currently advertises webhook capability. Do not set `webhooks: true` until event synthesis, signing, delivery timing, retries, and failure semantics have tests.

## Conformance Fixtures

Every migrated pack must provide at least one fixture that exercises its main mutation or read flow. Run it through the common harness:

```ts
const runtime = createProviderRuntime({
  clock: { now: () => new Date("2026-08-06T12:00:00.000Z") },
  idGenerator: { create: (prefix) => `${prefix}_fixture` },
});

runProviderPackConformance(examplePack, runtime);
```

The harness:

1. selects an API version;
2. parses and validates the fixture request;
3. generates a deterministic response;
4. runs the fixture response assertion;
5. computes and validates the state transition;
6. runs the fixture transition assertion.

Malformed responses and wrong state keys must fail the harness.

## Adding Or Migrating A Pack

1. Add one pack under `src/providers/packs/`.
2. Register it in the ordered built-in pack list in `src/providers/registry.ts`.
3. Remove only that provider's legacy detection, validation, generation, prompt, and scenario branches.
4. Preserve route detection precedence and generic REST fallback.
5. Add conformance, provider regression, manifest API, state, cache, and provider-shaped error tests.
6. Run `npm run typecheck`, `npm test`, and `npm run build`.
7. Inspect built CLI output and package contents before release.

## Migration Plan

The remaining providers should move one at a time:

| Order | Provider | Migration focus                                                                                                    | Deferred risk                                                                 |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 1     | Twilio   | Form parsing, validation, SID generation, error shape                                                              | Message status transitions and callbacks                                      |
| 2     | GitHub   | Version header, deterministic issue/repository shapes, scenarios                                                   | Pagination and conditional requests                                           |
| 3     | OpenAI   | API version policy, typed response families, list state                                                            | Streaming and token accounting                                                |
| 4     | Discord  | Route/body detection and message shapes                                                                            | Webhook and interaction semantics                                             |
| Done  | Stripe   | Core pack for customers, payment intents, payment methods, checkout sessions, refunds, pagination, and idempotency | Webhooks, subscriptions, invoices, disputes, and broader state-machine parity |

Stripe now demonstrates the deeper stateful pack path. See [`stripe-core-pack.md`](stripe-core-pack.md) for the supported contract and limits.

Generic REST should not become a provider pack. It remains the explicit fallback so unknown APIs continue to work without pretending to have a provider contract.
