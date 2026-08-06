import type {
  ProviderConformanceFixture,
  ProviderErrorDetails,
  ProviderPack,
  ProviderResponse,
  ProviderScenario,
  ProviderStateTransition
} from "../types.js";
import type { NormalizedRequest } from "../../proxy/requestNormalizer.js";
import { isJsonObject } from "../../utils/json.js";

const STRIPE_API_VERSION = "2026-02-25.clover";
const STRIPE_PACK_VERSION = "1.1.0";
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

type StripeRequest = {
  params: Record<string, unknown>;
  idempotencyKey: string | undefined;
};

type StripeStoredIdempotency = {
  method: string;
  path: string;
  params: string;
  created: number;
  response: ProviderResponse;
};

const stripeScenarios: readonly ProviderScenario[] = [
  {
    id: "stripe-payment-intent-card-declined",
    title: "Stripe card declined",
    provider: "stripe",
    description: "A confirmed Payment Intent using pm_card_chargeDeclined returns a Stripe card_error.",
    steps: [{
      name: "Confirm declined payment intent",
      method: "POST",
      path: "/v1/payment_intents",
      status: 402,
      body: { error: { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined.", param: "payment_method" } }
    }]
  }
  ,
  {
    id: "stripe-subscription-payment-failed",
    title: "Stripe subscription renewal payment failed",
    provider: "stripe",
    description: "A renewal with pm_card_chargeDeclined leaves the invoice open and subscription past_due.",
    steps: [{
      name: "Renew subscription with declined card",
      method: "POST",
      path: "/v1/subscriptions/sub_ghostapi/renew",
      status: 402,
      body: { error: { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined.", param: "payment_method" } }
    }]
  }
];

const stripeConformanceFixtures: readonly ProviderConformanceFixture[] = [
  {
    name: "create a form-encoded customer",
    request: {
      method: "POST",
      path: "/v1/customers",
      query: {},
      headers: { "content-type": "application/x-www-form-urlencoded", "stripe-version": STRIPE_API_VERSION },
      body: "email=ada%40example.com&name=Ada%20Lovelace&metadata%5Bsource%5D=fixture",
      receivedAt: "2026-08-06T12:00:00.000Z"
    },
    assertResponse(response) {
      if (!isJsonObject(response.body) || response.body.object !== "customer" || response.body.id !== "cus_fixture" || response.body.email !== "ada@example.com") {
        return "response must contain a deterministic Stripe customer";
      }
      if (response.headers["request-id"] !== "req_fixture") return "response must contain a deterministic request-id";
      return null;
    },
    assertStateTransition(transition, response) {
      if (transition === null || transition.key !== "stripe:cus_fixture" || transition.value !== response.body) {
        return "state transition must persist the exact customer under its Stripe id";
      }
      return null;
    }
  },
  {
    name: "create a deterministic billing product",
    request: {
      method: "POST",
      path: "/v1/products",
      query: {},
      headers: { "content-type": "application/json", "stripe-version": STRIPE_API_VERSION },
      body: { name: "GhostAPI Pro", metadata: { tier: "pro" } },
      receivedAt: "2026-08-06T12:00:00.000Z"
    },
    assertResponse(response) {
      if (!isJsonObject(response.body) || response.body.object !== "product" || response.body.id !== "prod_fixture" || response.body.name !== "GhostAPI Pro") {
        return "response must contain a deterministic Stripe billing product";
      }
      return null;
    },
    assertStateTransition(transition, response) {
      if (transition === null || transition.key !== "stripe:prod_fixture" || transition.value !== response.body) {
        return "state transition must persist the exact billing product under its Stripe id";
      }
      return null;
    }
  }
];

export const stripePack: ProviderPack = {
  name: "stripe",
  displayName: "Stripe",
  manifest: {
    schemaVersion: 1,
    name: "stripe",
    displayName: "Stripe",
    implementation: "pack",
    packVersion: STRIPE_PACK_VERSION,
    apiVersions: { default: STRIPE_API_VERSION, supported: [STRIPE_API_VERSION] },
    capabilities: {
      detection: true,
      requestParsing: true,
      validation: true,
      deterministicResponses: true,
      stateTransitions: true,
      providerErrors: true,
      scenarios: true,
      webhooks: true,
      conformanceFixtures: true
    }
  },
  detection: {
    priority: 400,
    matches: ({ path }) => /^\/v1\/(?:customers|products|prices|subscriptions|invoices|events|payment_intents|payment_methods|checkout\/sessions|refunds)(?:\/|$)/.test(path.toLowerCase())
  },
  parseRequest(request): StripeRequest {
    return parseStripeRequest(request);
  },
  selectApiVersion(request) {
    const requested = firstHeaderValue(request.headers["stripe-version"]) ?? STRIPE_API_VERSION;
    if (requested === STRIPE_API_VERSION) return { version: requested };
    return {
      error: {
        status: 400,
        type: "invalid_request_error",
        code: "invalid_api_version",
        param: "Stripe-Version",
        message: `Unsupported Stripe API version: ${requested}. Supported version: ${STRIPE_API_VERSION}.`
      }
    };
  },
  validate(parsedRequest, request) {
    const parsed = readStripeRequest(parsedRequest);
    if (request.method === "POST" && request.path === "/v1/customers" && Object.keys(parsed.params).length === 0) return missingParam("email");
    if (request.method === "POST" && request.path === "/v1/payment_intents") {
      if (parsed.params.amount === undefined) return missingParam("amount");
      if (!hasPositiveInteger(parsed.params.amount)) return invalidParamError("amount", "Invalid positive integer: amount.");
      if (!hasCurrency(parsed.params.currency)) return missingParam("currency");
    }
    if (request.method === "POST" && request.path === "/v1/payment_methods" && typeof parsed.params.type !== "string") return missingParam("type");
    if (request.method === "POST" && request.path === "/v1/checkout/sessions") {
      if (!hasMode(parsed.params.mode)) return missingParam("mode");
      if (typeof parsed.params.success_url !== "string") return missingParam("success_url");
      if (typeof parsed.params.cancel_url !== "string") return missingParam("cancel_url");
    }
    if (request.method === "POST" && request.path === "/v1/products" && typeof parsed.params.name !== "string") return missingParam("name");
    if (request.method === "POST" && request.path === "/v1/prices") {
      if (!hasPositiveInteger(parsed.params.unit_amount)) return invalidParamError("unit_amount", "Invalid positive integer: unit_amount.");
      if (!hasCurrency(parsed.params.currency)) return missingParam("currency");
    }
    if (request.method === "POST" && request.path === "/v1/subscriptions") {
      if (typeof parsed.params.customer !== "string") return missingParam("customer");
      if (subscriptionPriceId(parsed.params.items) === undefined) return missingParam("items[0][price]");
      const trialDays = parsed.params.trial_period_days;
      if (trialDays !== undefined && readNonNegativeInteger(trialDays) === undefined) return invalidParamError("trial_period_days", "Invalid non-negative integer: trial_period_days.");
    }
    if (request.method === "POST" && request.path === "/v1/refunds" && typeof parsed.params.payment_intent !== "string" && typeof parsed.params.charge !== "string") {
      return missingParam("payment_intent");
    }
    return null;
  },
  handleDeterministic({ request, parsedRequest, runtime }): ProviderResponse {
    const parsed = readStripeRequest(parsedRequest);
    const now = Math.floor(runtime.requireCapability("clock").now().getTime() / 1000);
    const snapshot = runtime.requireCapability("state").snapshot();
    const replay = resolveIdempotencyReplay(snapshot, request, parsed, now);
    if (replay !== null) return replay;
    const response = dispatchStripeRequest(request, parsed.params, snapshot, runtime, now);
    return {
      ...response,
      headers: {
        "content-type": "application/json",
        ...createStripeResponseHeaders(runtime),
        "stripe-version": STRIPE_API_VERSION,
        ...response.headers
      }
    };
  },
  createResponseHeaders({ runtime }) {
    return createStripeResponseHeaders(runtime);
  },
  transitionState({ request, response, runtime }): ProviderStateTransition | null {
    if (response.headers["x-ghostapi-idempotency"] === "REPLAY") return null;
    const resource = resourceFromResponse(response.body);
    if (!isMutation(request.method)) return null;
    const parsed = parseStripeRequest(request);
    const now = Math.floor(runtime.requireCapability("clock").now().getTime() / 1000);
    const additionalWrites = [...(response.stateWrites ?? []), ...(parsed.idempotencyKey === undefined || request.method !== "POST" ? [] : [{
      key: `stripe:idempotency:${parsed.idempotencyKey}`,
      value: {
        method: request.method,
        path: request.path,
        params: stableStringify(parsed.params),
        created: now,
        response: { status: response.status, headers: response.headers, body: response.body }
      } satisfies StripeStoredIdempotency
    }])];
    if (resource === null) {
      const [firstWrite, ...remainingWrites] = additionalWrites;
      return firstWrite === undefined ? null : { key: firstWrite.key, value: firstWrite.value, additionalWrites: remainingWrites };
    }
    return { key: `stripe:${resource.id}`, value: resource, additionalWrites };
  },
  stateful: true,
  formatError(details: ProviderErrorDetails) {
    return stripeError(details);
  },
  promptHints: [
    "This is the Stripe API billing pack with deterministic Customers, Products, Prices, Subscriptions, Invoices, Payment Intents, Payment Methods, Checkout Sessions, Refunds, and pull-based signed webhook events.",
    "Unsupported Stripe endpoints return a diagnostic invalid_request_error rather than a generated success."
  ],
  scenarios: stripeScenarios,
  conformanceFixtures: stripeConformanceFixtures
};

function dispatchStripeRequest(request: NormalizedRequest, params: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  const segments = request.path.split("/").filter(Boolean);
  const resource = segments[1];
  const id = segments[2];
  const action = segments[3];

  if (resource === "customers") return handleCustomers(request.method, id, action, params, request.query, state, runtime, now);
  if (resource === "products") return handleProducts(request.method, id, action, params, request.query, state, runtime, now);
  if (resource === "prices") return handlePrices(request.method, id, action, params, request.query, state, runtime, now);
  if (resource === "subscriptions") return handleSubscriptions(request.method, id, action, params, request.query, state, runtime, now);
  if (resource === "invoices") return handleInvoices(request.method, id, action, params, request.query, state, runtime, now);
  if (resource === "events") return handleEvents(request.method, id, action, params, request.query, state);
  if (resource === "payment_intents") return handlePaymentIntents(request.method, id, action, params, request.query, state, runtime, now);
  if (resource === "payment_methods") return handlePaymentMethods(request.method, id, action, params, request.query, state, runtime, now);
  if (resource === "checkout" && segments[2] === "sessions") return handleCheckoutSessions(request.method, segments[3], segments[4], params, request.query, state, runtime, now);
  if (resource === "refunds") return handleRefunds(request.method, id, action, params, request.query, state, runtime, now);
  return unsupportedEndpoint(request);
}

function handleProducts(method: string, id: string | undefined, action: string | undefined, params: Record<string, unknown>, query: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  if (action !== undefined) return unsupportedEndpointFor("products", method);
  if (method === "GET" && id === undefined) return stripeList("/v1/products", listResources(state, "product"), query);
  if (method === "POST" && id === undefined) {
    return stripeObject({ id: runtime.requireCapability("idGenerator").create("prod"), object: "product", active: params.active !== false, name: stringOrNull(params.name) ?? "GhostAPI product", description: stringOrNull(params.description), metadata: recordOrEmpty(params.metadata), livemode: false, created: now, updated: now });
  }
  const product = id === undefined ? null : getResource(state, id, "product");
  if (product === null) return notFound("product", id);
  if (method === "GET") return stripeObject(product);
  if (method === "POST") return stripeObject({ ...product, ...pick(params, ["name", "description", "active", "metadata"]), updated: now, metadata: isJsonObject(params.metadata) ? params.metadata : product.metadata });
  return unsupportedEndpointFor("products", method);
}

function handlePrices(method: string, id: string | undefined, action: string | undefined, params: Record<string, unknown>, query: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  if (action !== undefined) return unsupportedEndpointFor("prices", method);
  if (method === "GET" && id === undefined) return stripeList("/v1/prices", listResources(state, "price"), query);
  if (method === "POST" && id === undefined) {
    const productId = typeof params.product === "string" ? params.product : undefined;
    if (productId !== undefined && getResource(state, productId, "product") === null) return notFound("product", productId);
    if (!hasPositiveInteger(params.unit_amount)) return invalidParam("unit_amount", "Invalid positive integer: unit_amount.");
    if (!hasCurrency(params.currency)) return missingParamResponse("currency");
    const recurring = parseRecurring(params.recurring);
    if (recurring.error !== null) return stripeFailure(400, "invalid_request_error", recurring.error, "recurring[interval]", "parameter_invalid_enum");
    return stripeObject({ id: runtime.requireCapability("idGenerator").create("price"), object: "price", active: params.active !== false, currency: String(params.currency).toLowerCase(), unit_amount: params.unit_amount, product: productId ?? null, nickname: stringOrNull(params.nickname), recurring: recurring.value, metadata: recordOrEmpty(params.metadata), livemode: false, created: now });
  }
  const price = id === undefined ? null : getResource(state, id, "price");
  if (price === null) return notFound("price", id);
  if (method === "GET") return stripeObject(price);
  if (method === "POST") return stripeObject({ ...price, ...pick(params, ["active", "nickname", "metadata"]), metadata: isJsonObject(params.metadata) ? params.metadata : price.metadata });
  return unsupportedEndpointFor("prices", method);
}

function handleSubscriptions(method: string, id: string | undefined, action: string | undefined, params: Record<string, unknown>, query: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  if (method === "GET" && id === undefined) return stripeList("/v1/subscriptions", listResources(state, "subscription"), query);
  if (method === "POST" && id === undefined) return createSubscription(params, state, runtime, now);
  const subscription = id === undefined ? null : getResource(state, id, "subscription");
  if (subscription === null) return notFound("subscription", id);
  if (method === "GET" && action === undefined) return stripeObject(subscription);
  if (method === "POST" && action === "cancel") return updateSubscriptionStatus(subscription, "canceled", now, ["customer.subscription.deleted"], runtime);
  if (method === "POST" && action === "renew") return renewSubscription(subscription, params, state, runtime, now);
  if (method === "POST" && action === undefined) {
    if (params.cancel_at_period_end === true) return responseWithWebhookWrites({ ...subscription, cancel_at_period_end: true, updated: now }, ["customer.subscription.updated"], runtime, now);
    return responseWithWebhookWrites({ ...subscription, ...pick(params, ["metadata", "default_payment_method"]), metadata: isJsonObject(params.metadata) ? params.metadata : subscription.metadata, updated: now }, ["customer.subscription.updated"], runtime, now);
  }
  if (method === "DELETE" && action === undefined) return updateSubscriptionStatus(subscription, "canceled", now, ["customer.subscription.deleted"], runtime);
  return unsupportedEndpointFor("subscriptions", method);
}

function handleInvoices(method: string, id: string | undefined, action: string | undefined, params: Record<string, unknown>, query: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  if (method === "GET" && id === undefined) return stripeList("/v1/invoices", listResources(state, "invoice"), query);
  const invoice = id === undefined ? null : getResource(state, id, "invoice");
  if (invoice === null) return notFound("invoice", id);
  if (method === "GET" && action === undefined) return stripeObject(invoice);
  if (method === "POST" && action === "pay") return payInvoice(invoice, params, state, runtime, now);
  if (method === "POST" && action === "void") return responseWithWebhookWrites({ ...invoice, status: "void", paid: false, updated: now }, ["invoice.voided"], runtime, now);
  return unsupportedEndpointFor("invoices", method);
}

function handleEvents(method: string, id: string | undefined, action: string | undefined, _params: Record<string, unknown>, query: Record<string, unknown>, state: Readonly<Record<string, unknown>>): ProviderResponse {
  if (method === "GET" && id === undefined) return stripeList("/v1/events", orderedWebhookEvents(state, query), query);
  if (method === "GET" && id !== undefined && (action === undefined || action === "deliver")) {
    const event = getResource(state, id, "event");
    if (event === null) return notFound("event", id);
    return stripeObject(event);
  }
  return unsupportedEndpointFor("events", method);
}

function createSubscription(params: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  const customerId = typeof params.customer === "string" ? params.customer : undefined;
  if (customerId === undefined) return missingParamResponse("customer");
  if (getResource(state, customerId, "customer") === null) return notFound("customer", customerId);
  const priceId = subscriptionPriceId(params.items);
  if (priceId === undefined) return missingParamResponse("items[0][price]");
  const price = getResource(state, priceId, "price");
  if (price === null) return notFound("price", priceId);
  if (!isJsonObject(price.recurring)) return stripeFailure(400, "invalid_request_error", "Subscription prices require recurring configuration.", "items[0][price]", "parameter_invalid_empty");

  const trialDays = readNonNegativeInteger(params.trial_period_days) ?? 0;
  const id = runtime.requireCapability("idGenerator").create("sub");
  const periodEnd = now + (trialDays > 0 ? trialDays * 86_400 : recurringSeconds(price.recurring));
  const subscription = {
    id,
    object: "subscription",
    customer: customerId,
    status: trialDays > 0 ? "trialing" : "active",
    cancel_at_period_end: false,
    current_period_start: now,
    current_period_end: periodEnd,
    trial_start: trialDays > 0 ? now : null,
    trial_end: trialDays > 0 ? periodEnd : null,
    default_payment_method: stringOrNull(params.default_payment_method),
    items: { object: "list", data: [{ id: runtime.requireCapability("idGenerator").create("si"), object: "subscription_item", price: priceId, quantity: subscriptionQuantity(params.items) }] },
    latest_invoice: null,
    metadata: recordOrEmpty(params.metadata),
    livemode: false,
    created: now,
    updated: now
  };
  if (trialDays === 0) {
    const invoice = createInvoice(subscription, price, runtime, now, "paid", "subscription_create");
    const paymentIntent = createPaymentIntent({ amount: price.unit_amount, currency: price.currency, customer: customerId, payment_method: params.default_payment_method }, runtime, now, true);
    const createdSubscription = { ...subscription, latest_invoice: invoice.id };
    const response = responseWithWebhookWrites(createdSubscription, ["customer.subscription.created", "invoice.paid", "invoice.payment_succeeded"], runtime, now, { "invoice.paid": invoice, "invoice.payment_succeeded": invoice });
    response.stateWrites = [...(response.stateWrites ?? []), { key: `stripe:${invoice.id}`, value: { ...invoice, payment_intent: paymentIntent.id } }, { key: `stripe:${paymentIntent.id}`, value: paymentIntent }];
    return response;
  }
  return responseWithWebhookWrites(subscription, ["customer.subscription.created"], runtime, now);
}

function renewSubscription(subscription: Record<string, unknown>, params: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  if (subscription.status === "canceled") return stripeFailure(400, "invalid_request_error", "Canceled subscriptions cannot be renewed.", "id", "resource_missing");
  const priceId = subscriptionPriceId(subscription.items);
  const price = priceId === undefined ? null : getResource(state, priceId, "price");
  if (price === null) return stripeFailure(500, "api_error", "Subscription has no valid recurring price.", undefined, "subscription_invalid");
  const declined = isDeclined(params) || isDeclined({ payment_method: params.payment_method ?? subscription.default_payment_method });
  const status = declined ? "open" : "paid";
  const invoice = createInvoice(subscription, price, runtime, now, status, "subscription_cycle");
  const nextStatus = declined ? "past_due" : "active";
  const nextSubscription = {
    ...subscription,
    status: nextStatus,
    current_period_start: now,
    current_period_end: now + recurringSeconds(price.recurring),
    latest_invoice: invoice.id,
    updated: now
  };
  if (declined) {
    const failure = cardDeclined();
    return {
      ...failure,
      stateWrites: [
        { key: `stripe:${invoice.id}`, value: invoice },
        { key: `stripe:${subscription.id}`, value: nextSubscription },
        ...createWebhookWrites(["invoice.payment_failed", "customer.subscription.updated"], nextSubscription, runtime, now)
      ]
    };
  }
  const paymentIntent = createPaymentIntent({ amount: price.unit_amount, currency: price.currency, customer: subscription.customer, payment_method: params.payment_method ?? subscription.default_payment_method }, runtime, now, true);
  const response = responseWithWebhookWrites(nextSubscription, ["invoice.paid", "invoice.payment_succeeded", "customer.subscription.updated"], runtime, now, { "invoice.paid": invoice, "invoice.payment_succeeded": invoice });
  response.stateWrites = [...(response.stateWrites ?? []), { key: `stripe:${invoice.id}`, value: { ...invoice, payment_intent: paymentIntent.id } }, { key: `stripe:${paymentIntent.id}`, value: paymentIntent }];
  return response;
}

function payInvoice(invoice: Record<string, unknown>, params: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  if (invoice.status === "paid") return stripeObject(invoice);
  if (invoice.status === "void") return stripeFailure(400, "invalid_request_error", "Void invoices cannot be paid.", "id", "invoice_invalid");
  const subscription = typeof invoice.subscription === "string" ? getResource(state, invoice.subscription, "subscription") : null;
  if (isDeclined(params) || isDeclined({ payment_method: params.payment_method ?? subscription?.default_payment_method })) {
    const failedInvoice = { ...invoice, status: "open", paid: false, updated: now, attempt_count: numberOr(invoice.attempt_count, 0) + 1 };
    const writes = [{ key: `stripe:${String(invoice.id)}`, value: failedInvoice }, ...(subscription === null ? [] : [{ key: `stripe:${subscription.id}`, value: { ...subscription, status: "past_due", updated: now } }]), ...createWebhookWrites(["invoice.payment_failed", ...(subscription === null ? [] : ["customer.subscription.updated"])], failedInvoice, runtime, now)];
    return { ...cardDeclined(), stateWrites: writes };
  }
  const paidInvoice = { ...invoice, status: "paid", paid: true, amount_paid: invoice.amount_due, amount_remaining: 0, updated: now, attempt_count: numberOr(invoice.attempt_count, 0) + 1 };
  const response = responseWithWebhookWrites(paidInvoice, ["invoice.paid", "invoice.payment_succeeded"], runtime, now);
  if (subscription !== null) response.stateWrites = [...(response.stateWrites ?? []), { key: `stripe:${subscription.id}`, value: { ...subscription, status: "active", latest_invoice: invoice.id, updated: now } }];
  return response;
}

function updateSubscriptionStatus(subscription: Record<string, unknown>, status: string, now: number, eventTypes: string[], runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"]): ProviderResponse {
  return responseWithWebhookWrites({ ...subscription, status, canceled_at: status === "canceled" ? now : null, cancel_at_period_end: false, updated: now }, eventTypes, runtime, now);
}

function createInvoice(subscription: Record<string, unknown>, price: Record<string, unknown>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number, status: "paid" | "open", billingReason: string): Record<string, unknown> {
  const id = runtime.requireCapability("idGenerator").create("in");
  const amount = numberOr(price.unit_amount, 0);
  return { id, object: "invoice", customer: subscription.customer, subscription: subscription.id, status, paid: status === "paid", amount_due: amount, amount_paid: status === "paid" ? amount : 0, amount_remaining: status === "paid" ? 0 : amount, currency: price.currency, billing_reason: billingReason, payment_intent: null, attempt_count: 1, metadata: {}, livemode: false, created: now, updated: now };
}

function responseWithWebhookWrites(resource: Record<string, unknown>, eventTypes: string[], runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number, eventObjects: Readonly<Record<string, Record<string, unknown>>> = {}): ProviderResponse {
  return { status: 200, headers: {}, body: resource, stateWrites: createWebhookWrites(eventTypes, resource, runtime, now, eventObjects) };
}

function createWebhookWrites(eventTypes: string[], dataObject: Record<string, unknown>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number, eventObjects: Readonly<Record<string, Record<string, unknown>>> = {}): { key: string; value: unknown }[] {
  return eventTypes.map((type) => {
    const id = runtime.requireCapability("idGenerator").create("evt");
    return { key: `stripe:${id}`, value: { id, object: "event", api_version: STRIPE_API_VERSION, created: now, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type, data: { object: structuredClone(eventObjects[type] ?? dataObject) } } };
  });
}

function createStripeResponseHeaders(runtime: Parameters<ProviderPack["createResponseHeaders"]>[0]["runtime"]): Record<string, string> {
  return { "request-id": runtime.requireCapability("idGenerator").create("req") };
}

function handleCustomers(method: string, id: string | undefined, action: string | undefined, params: Record<string, unknown>, query: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  if (action !== undefined) return unsupportedEndpointFor("customers", method);
  if (method === "GET" && id === undefined) return stripeList("/v1/customers", listResources(state, "customer"), query);
  if (method === "POST" && id === undefined) return stripeObject({ id: runtime.requireCapability("idGenerator").create("cus"), object: "customer", email: stringOrNull(params.email), name: stringOrNull(params.name), description: stringOrNull(params.description), metadata: recordOrEmpty(params.metadata), livemode: false, created: now });
  const customer = id === undefined ? null : getResource(state, id, "customer");
  if (customer === null) return notFound("customer", id);
  if (method === "GET") return stripeObject(customer);
  if (method === "POST") return stripeObject({ ...customer, ...pick(params, ["email", "name", "description", "metadata"]), metadata: isJsonObject(params.metadata) ? params.metadata : customer.metadata });
  if (method === "DELETE") return stripeObject({ id, object: "customer", deleted: true });
  return unsupportedEndpointFor("customers", method);
}

function handlePaymentMethods(method: string, id: string | undefined, action: string | undefined, params: Record<string, unknown>, query: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  if (action !== undefined) return unsupportedEndpointFor("payment_methods", method);
  if (method === "GET" && id === undefined) return stripeList("/v1/payment_methods", listResources(state, "payment_method"), query);
  if (method === "POST" && id === undefined) {
    const type = String(params.type);
    if (type !== "card") return stripeFailure(400, "invalid_request_error", "Only payment method type 'card' is supported by this GhostAPI Stripe pack.", "type", "parameter_invalid_enum");
    return stripeObject({ id: runtime.requireCapability("idGenerator").create("pm"), object: "payment_method", type, card: { brand: "visa", country: "US", exp_month: 12, exp_year: 2030, funding: "credit", last4: "4242" }, billing_details: recordOrEmpty(params.billing_details), customer: null, livemode: false, created: now });
  }
  const paymentMethod = id === undefined ? null : getResource(state, id, "payment_method");
  if (paymentMethod === null) return notFound("payment_method", id);
  if (method === "GET") return stripeObject(paymentMethod);
  return unsupportedEndpointFor("payment_methods", method);
}

function handlePaymentIntents(method: string, id: string | undefined, action: string | undefined, params: Record<string, unknown>, query: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  if (method === "GET" && id === undefined) return stripeList("/v1/payment_intents", listResources(state, "payment_intent"), query);
  if (method === "POST" && id === undefined) {
    if (isDeclined(params)) return cardDeclined();
    const paymentIntent = createPaymentIntent(params, runtime, now, Boolean(params.confirm));
    return params.confirm === true ? responseWithWebhookWrites(paymentIntent, ["payment_intent.succeeded"], runtime, now) : stripeObject(paymentIntent);
  }
  const paymentIntent = id === undefined ? null : getResource(state, id, "payment_intent");
  if (paymentIntent === null) return notFound("payment_intent", id);
  if (method === "GET" && action === undefined) return stripeObject(paymentIntent);
  if (method === "POST" && action === "confirm") {
    if (isDeclined(params)) return cardDeclined();
    return responseWithWebhookWrites({ ...paymentIntent, ...pick(params, ["payment_method", "metadata"]), status: "succeeded", amount_received: paymentIntent.amount, latest_charge: `ch_${id}`, next_action: null }, ["payment_intent.succeeded"], runtime, now);
  }
  if (method === "POST" && action === undefined) return stripeObject({ ...paymentIntent, ...pick(params, ["amount", "currency", "description", "metadata", "payment_method"]), amount: numberOr(paymentIntent.amount, params.amount), status: paymentIntent.status });
  return unsupportedEndpointFor("payment_intents", method);
}

function handleCheckoutSessions(method: string, id: string | undefined, action: string | undefined, params: Record<string, unknown>, query: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  if (action !== undefined) return unsupportedEndpointFor("checkout/sessions", method);
  if (method === "GET" && id === undefined) return stripeList("/v1/checkout/sessions", listResources(state, "checkout.session"), query);
  if (method === "POST" && id === undefined) {
    const sessionId = runtime.requireCapability("idGenerator").create("cs_test");
    return stripeObject({ id: sessionId, object: "checkout.session", mode: params.mode, status: "open", payment_status: "unpaid", customer: stringOrNull(params.customer), success_url: params.success_url, cancel_url: params.cancel_url, url: `http://127.0.0.1:8080/v1/checkout/sessions/${sessionId}/mock-hosted-page`, amount_total: checkoutAmount(params), currency: checkoutCurrency(params), livemode: false, created: now, metadata: recordOrEmpty(params.metadata) });
  }
  const session = id === undefined ? null : getResource(state, id, "checkout.session");
  if (session === null) return notFound("checkout.session", id);
  if (method === "GET") return stripeObject(session);
  return unsupportedEndpointFor("checkout/sessions", method);
}

function handleRefunds(method: string, id: string | undefined, action: string | undefined, params: Record<string, unknown>, query: Record<string, unknown>, state: Readonly<Record<string, unknown>>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number): ProviderResponse {
  if (action !== undefined) return unsupportedEndpointFor("refunds", method);
  if (method === "GET" && id === undefined) return stripeList("/v1/refunds", listResources(state, "refund"), query);
  if (method === "POST" && id === undefined) {
    const paymentIntentId = typeof params.payment_intent === "string" ? params.payment_intent : undefined;
    const paymentIntent = paymentIntentId === undefined ? null : getResource(state, paymentIntentId, "payment_intent");
    if (paymentIntentId !== undefined && paymentIntent === null) return notFound("payment_intent", paymentIntentId);
    const amount = typeof params.amount === "number" ? params.amount : typeof paymentIntent?.amount === "number" ? paymentIntent.amount : null;
    if (amount === null || !Number.isInteger(amount) || amount <= 0) return invalidParam("amount", "Invalid positive integer: amount.");
    const refund = { id: runtime.requireCapability("idGenerator").create("re"), object: "refund", amount, currency: typeof paymentIntent?.currency === "string" ? paymentIntent.currency : "usd", payment_intent: paymentIntentId ?? null, charge: typeof params.charge === "string" ? params.charge : null, status: "succeeded", reason: stringOrNull(params.reason), metadata: recordOrEmpty(params.metadata), livemode: false, created: now };
    const response = responseWithWebhookWrites(refund, ["charge.refunded"], runtime, now);
    if (paymentIntent !== null) response.stateWrites = [...(response.stateWrites ?? []), { key: `stripe:${paymentIntent.id}`, value: { ...paymentIntent, amount_refunded: numberOr(paymentIntent.amount_refunded, 0) + amount, status: "succeeded" } }];
    return response;
  }
  const refund = id === undefined ? null : getResource(state, id, "refund");
  if (refund === null) return notFound("refund", id);
  if (method === "GET") return stripeObject(refund);
  return unsupportedEndpointFor("refunds", method);
}

function createPaymentIntent(params: Record<string, unknown>, runtime: Parameters<ProviderPack["handleDeterministic"]>[0]["runtime"], now: number, confirmed: boolean): Record<string, unknown> {
  const id = runtime.requireCapability("idGenerator").create("pi");
  return { id, object: "payment_intent", amount: params.amount, amount_received: confirmed ? params.amount : 0, currency: params.currency, customer: stringOrNull(params.customer), description: stringOrNull(params.description), metadata: recordOrEmpty(params.metadata), payment_method: stringOrNull(params.payment_method), client_secret: `${id}_secret_ghostapi`, status: confirmed ? "succeeded" : "requires_payment_method", confirmation_method: "automatic", capture_method: "automatic", latest_charge: confirmed ? `ch_${id}` : null, livemode: false, created: now };
}

function resolveIdempotencyReplay(state: Readonly<Record<string, unknown>>, request: NormalizedRequest, parsed: StripeRequest, now: number): ProviderResponse | null {
  if (parsed.idempotencyKey === undefined || !isMutation(request.method)) return null;
  const stored = state[`stripe:idempotency:${parsed.idempotencyKey}`];
  if (!isStoredIdempotency(stored)) return null;
  if (stored.created + IDEMPOTENCY_TTL_SECONDS <= now) return null;
  if (stored.method !== request.method || stored.path !== request.path || stored.params !== stableStringify(parsed.params)) {
    return stripeFailure(400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.", undefined, "idempotency_key_in_use");
  }
  return {
    ...stored.response,
    headers: { ...stored.response.headers, "x-ghostapi-idempotency": "REPLAY" },
    body: restoreSyntheticClientSecret(stored.response.body)
  };
}

function parseStripeRequest(request: NormalizedRequest): StripeRequest {
  const contentType = firstHeaderValue(request.headers["content-type"]) ?? "";
  return {
    params: parseStripeParams(request.body, contentType.includes("application/x-www-form-urlencoded")),
    idempotencyKey: firstHeaderValue(request.headers["idempotency-key"])
  };
}

function parseStripeParams(body: unknown, formEncoded: boolean): Record<string, unknown> {
  if (isJsonObject(body)) return formEncoded ? coerceFormParams(body) : structuredClone(body);
  if (typeof body !== "string") return {};
  const params: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(body)) setBracketValue(params, key, value);
  return params;
}

function coerceFormParams(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, coerceFormParameter(entry)]));
}

function coerceFormParameter(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(coerceFormParameter);
  if (isJsonObject(value)) return coerceFormParams(value);
  return typeof value === "string" ? coerceFormValue(value) : value;
}

function setBracketValue(target: Record<string, unknown>, key: string, value: string): void {
  const parts = key.match(/[^\[\]]+/g) ?? [];
  if (parts.length === 0) return;
  let cursor: Record<string, unknown> | unknown[] = target;
  for (const [index, part] of parts.entries()) {
    const nextPart = parts[index + 1];
    const numericPart = /^\d+$/.test(part) ? Number(part) : undefined;
    if (index === parts.length - 1) {
      if (Array.isArray(cursor) && numericPart !== undefined) cursor[numericPart] = coerceFormValue(value);
      else if (!Array.isArray(cursor)) cursor[part] = coerceFormValue(value);
      return;
    }
    const createArray = nextPart !== undefined && /^\d+$/.test(nextPart);
    if (Array.isArray(cursor) && numericPart !== undefined) {
      const existing = cursor[numericPart];
      if (!isJsonObject(existing) && !Array.isArray(existing)) cursor[numericPart] = createArray ? [] : {};
      cursor = cursor[numericPart] as Record<string, unknown> | unknown[];
      continue;
    }
    if (Array.isArray(cursor)) return;
    const existing = cursor[part];
    if (!isJsonObject(existing) && !Array.isArray(existing)) cursor[part] = createArray ? [] : {};
    cursor = cursor[part] as Record<string, unknown> | unknown[];
  }
}

function coerceFormValue(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function stripeList(url: string, values: Record<string, unknown>[], query: Record<string, unknown>): ProviderResponse {
  const limit = Math.min(Math.max(readPositiveInteger(query.limit) ?? 10, 1), 100);
  const startingAfter = typeof query.starting_after === "string" ? query.starting_after : undefined;
  const endingBefore = typeof query.ending_before === "string" ? query.ending_before : undefined;
  let start = 0;
  if (startingAfter !== undefined) {
    const index = values.findIndex((value) => value.id === startingAfter);
    if (index >= 0) start = index + 1;
  }
  if (endingBefore !== undefined) {
    const index = values.findIndex((value) => value.id === endingBefore);
    if (index >= 0) start = Math.max(0, index - limit);
  }
  const data = values.slice(start, start + limit);
  return stripeObject({ object: "list", data, has_more: start + limit < values.length, url });
}

function stripeObject(body: Record<string, unknown>): ProviderResponse {
  return { status: 200, headers: {}, body };
}

function stripeFailure(status: number, type: string, message: string, param?: string, code?: string): ProviderResponse {
  return { status, headers: {}, body: stripeError({ status, type, message, param, code }) };
}

function stripeError(details: ProviderErrorDetails): { error: { type: string; message: string; code?: string | number; param?: string; decline_code?: string } } {
  return { error: { type: details.type ?? "invalid_request_error", message: details.message, ...(details.code === undefined ? {} : { code: details.code }), param: details.param ?? "unknown" } };
}

function cardDeclined(): ProviderResponse {
  return { status: 402, headers: {}, body: { error: { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined.", param: "payment_method" } } };
}

function unsupportedEndpoint(request: NormalizedRequest): ProviderResponse {
  return stripeFailure(404, "invalid_request_error", `Unsupported Stripe endpoint: ${request.method} ${request.path}. This GhostAPI Stripe pack supports Customers, Payment Intents, Payment Methods, Checkout Sessions, and Refunds.`, undefined, "resource_missing");
}

function unsupportedEndpointFor(resource: string, method: string): ProviderResponse {
  return stripeFailure(405, "invalid_request_error", `Unsupported Stripe operation: ${method} /v1/${resource}.`, undefined, "method_not_allowed");
}

function notFound(resource: string, id: string | undefined): ProviderResponse {
  return stripeFailure(404, "invalid_request_error", `No such ${resource}: '${id ?? "unknown"}'`, "id", "resource_missing");
}

function missingParam(param: string): ProviderErrorDetails {
  return { status: 400, type: "invalid_request_error", code: "parameter_missing", param, message: `Missing required param: ${param}.` };
}

function invalidParam(param: string, message: string): ProviderResponse {
  return stripeFailure(400, "invalid_request_error", message, param, "parameter_invalid_integer");
}

function invalidParamError(param: string, message: string): ProviderErrorDetails {
  return { status: 400, type: "invalid_request_error", code: "parameter_invalid_integer", param, message };
}

function getResource(state: Readonly<Record<string, unknown>>, id: string, object: string): Record<string, unknown> | null {
  const value = state[`stripe:${id}`];
  if (!isJsonObject(value) || value.object !== object || value.deleted === true) return null;
  const resource = structuredClone(value);
  if (resource.object === "payment_intent" && resource.client_secret === "***") resource.client_secret = `${resource.id}_secret_ghostapi`;
  return resource;
}

function listResources(state: Readonly<Record<string, unknown>>, object: string): Record<string, unknown>[] {
  return Object.values(state)
    .filter((value): value is Record<string, unknown> => isJsonObject(value) && value.object === object && value.deleted !== true)
    .sort((left, right) => Number(right.created ?? 0) - Number(left.created ?? 0) || String(right.id).localeCompare(String(left.id)))
    .map((value) => structuredClone(value));
}

function resourceFromResponse(body: unknown): Record<string, unknown> | null {
  return isJsonObject(body) && typeof body.id === "string" && typeof body.object === "string" ? body : null;
}

function restoreSyntheticClientSecret(body: unknown): unknown {
  if (!isJsonObject(body) || body.object !== "payment_intent" || typeof body.id !== "string" || body.client_secret !== "***") return body;
  return { ...body, client_secret: `${body.id}_secret_ghostapi` };
}

function readStripeRequest(value: unknown): StripeRequest {
  if (!isJsonObject(value) || !isJsonObject(value.params)) return { params: {}, idempotencyKey: undefined };
  return { params: value.params, idempotencyKey: typeof value.idempotencyKey === "string" ? value.idempotencyKey : undefined };
}

function isStoredIdempotency(value: unknown): value is StripeStoredIdempotency {
  return isJsonObject(value) && typeof value.method === "string" && typeof value.path === "string" && typeof value.params === "string" && typeof value.created === "number" && isJsonObject(value.response) && typeof value.response.status === "number" && isJsonObject(value.response.headers) && "body" in value.response;
}

function hasPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function hasCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{3}$/i.test(value);
}

function hasMode(value: unknown): value is string {
  return value === "payment" || value === "setup" || value === "subscription";
}

function parseRecurring(value: unknown): { value: Record<string, unknown> | null; error: string | null } {
  if (value === undefined) return { value: null, error: null };
  if (!isJsonObject(value) || typeof value.interval !== "string") return { value: null, error: "Recurring prices require recurring[interval] to be day, week, month, or year." };
  if (!isRecurringInterval(value.interval)) return { value: null, error: "Recurring prices require recurring[interval] to be day, week, month, or year." };
  const intervalCount = readPositiveInteger(value.interval_count) ?? 1;
  return { value: { interval: value.interval, interval_count: intervalCount }, error: null };
}

function recurringSeconds(value: unknown): number {
  if (!isJsonObject(value) || typeof value.interval !== "string") return 30 * 86_400;
  const count = readPositiveInteger(value.interval_count) ?? 1;
  const unit = value.interval === "day" ? 86_400 : value.interval === "week" ? 7 * 86_400 : value.interval === "year" ? 365 * 86_400 : 30 * 86_400;
  return unit * count;
}

function subscriptionPriceId(items: unknown): string | undefined {
  const first = firstSubscriptionItem(items);
  return isJsonObject(first) && typeof first.price === "string" ? first.price : undefined;
}

function subscriptionQuantity(items: unknown): number {
  const first = firstSubscriptionItem(items);
  return isJsonObject(first) ? readPositiveInteger(first.quantity) ?? 1 : 1;
}

function firstSubscriptionItem(items: unknown): unknown {
  if (Array.isArray(items)) return items[0];
  if (!isJsonObject(items)) return undefined;
  if (Array.isArray(items.data)) return items.data[0];
  return Object.values(items)[0];
}

function orderedWebhookEvents(state: Readonly<Record<string, unknown>>, query: Record<string, unknown>): Record<string, unknown>[] {
  const events = listResources(state, "event");
  return query.delivery_mode === "out_of_order" ? events.reverse() : events;
}

function missingParamResponse(param: string): ProviderResponse {
  const details = missingParam(param);
  return stripeFailure(details.status, details.type ?? "invalid_request_error", details.message, details.param, String(details.code));
}

function isRecurringInterval(value: string): boolean {
  return value === "day" || value === "week" || value === "month" || value === "year";
}

function isDeclined(params: Record<string, unknown>): boolean {
  return params.payment_method === "pm_card_chargeDeclined" || params.payment_method === "tok_chargeDeclined";
}

function isMutation(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? structuredClone(value) : {};
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, structuredClone(value[key])]));
}

function numberOr(current: unknown, next: unknown): number {
  return typeof next === "number" ? next : typeof current === "number" ? current : 0;
}

function checkoutAmount(params: Record<string, unknown>): number | null {
  return checkoutLineItems(params).reduce<number | null>((total, item) => {
    if (total === null || !isJsonObject(item) || !isJsonObject(item.price_data) || typeof item.price_data.unit_amount !== "number") return null;
    const quantity = typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 1;
    return total + item.price_data.unit_amount * quantity;
  }, 0);
}

function checkoutCurrency(params: Record<string, unknown>): string | null {
  const first = checkoutLineItems(params)[0];
  return isJsonObject(first) && isJsonObject(first.price_data) && typeof first.price_data.currency === "string" ? first.price_data.currency : null;
}

function checkoutLineItems(params: Record<string, unknown>): unknown[] {
  const lineItems = params.line_items;
  if (Array.isArray(lineItems)) return lineItems;
  if (isJsonObject(lineItems)) return Object.values(lineItems);
  return [];
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isJsonObject(value)) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
