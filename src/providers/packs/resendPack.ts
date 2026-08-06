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

const RESEND_API_VERSION = "v1";

type ResendRequest = {
  body: Record<string, unknown>;
};

const resendScenarios: readonly ProviderScenario[] = [
  {
    id: "resend-email-send",
    title: "Resend email send",
    provider: "resend",
    description: "Returns a delivered email ID for transactional email flows.",
    steps: [
      {
        name: "Send email",
        method: "POST",
        path: "/emails",
        status: 200,
        body: { id: "email_ghostapi_123", object: "email", status: "sent" }
      }
    ]
  }
];

const resendConformanceFixtures: readonly ProviderConformanceFixture[] = [
  {
    name: "send email",
    request: {
      method: "POST",
      path: "/emails",
      query: {},
      headers: { "content-type": "application/json" },
      body: { from: "sender@example.com", to: "reader@example.com", subject: "Hello" },
      receivedAt: "2026-08-06T12:00:00.000Z"
    },
    assertResponse(response) {
      if (!isJsonObject(response.body) || typeof response.body.id !== "string" || !response.body.id.startsWith("email_mock_")) {
        return "response body must contain an email_mock_ id";
      }
      return null;
    },
    assertStateTransition(transition, response) {
      const id = isJsonObject(response.body) && typeof response.body.id === "string" ? response.body.id : "";
      if (transition === null || transition.key !== `resend:${id}` || transition.value !== response.body) {
        return "state transition must persist the exact response under the resend response id key";
      }
      return null;
    }
  }
];

export const resendPack: ProviderPack = {
  name: "resend",
  displayName: "Resend",
  manifest: {
    schemaVersion: 1,
    name: "resend",
    displayName: "Resend",
    implementation: "pack",
    packVersion: "1.0.0",
    apiVersions: { default: RESEND_API_VERSION, supported: [RESEND_API_VERSION] },
    capabilities: {
      detection: true,
      requestParsing: true,
      validation: true,
      deterministicResponses: true,
      stateTransitions: true,
      providerErrors: true,
      scenarios: true,
      webhooks: false,
      conformanceFixtures: true
    }
  },
  detection: {
    priority: 300,
    matches(input) {
      const path = input.path.toLowerCase();
      return path === "/emails" || path.startsWith("/emails/");
    }
  },
  parseRequest(request): ResendRequest {
    return { body: isJsonObject(request.body) ? request.body : {} };
  },
  selectApiVersion(request) {
    const requested = firstHeaderValue(request.headers["x-ghostapi-api-version"]) ?? RESEND_API_VERSION;
    if (requested === RESEND_API_VERSION) return { version: requested };
    return {
      error: {
        status: 400,
        type: "invalid_api_version",
        message: `Unsupported Resend API version: ${requested}. Supported versions: ${RESEND_API_VERSION}.`
      }
    };
  },
  validate(parsedRequest, request) {
    if (request.method !== "POST" || (request.path !== "/emails" && !request.path.startsWith("/emails/"))) return null;
    const body = readResendRequest(parsedRequest).body;
    if (!body.from) return validationError("from");
    if (!body.to) return validationError("to");
    if (!body.subject) return validationError("subject");
    return null;
  },
  handleDeterministic({ request, runtime }): ProviderResponse {
    const id = runtime.requireCapability("idGenerator").create("email_mock");
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { id, provider: "resend", method: request.method, path: request.path }
    };
  },
  transitionState({ request, response }): ProviderStateTransition | null {
    if (!isMutation(request.method) || !isJsonObject(response.body) || typeof response.body.id !== "string") return null;
    return { key: `resend:${response.body.id}`, value: response.body };
  },
  formatError(details: ProviderErrorDetails) {
    return {
      statusCode: details.status,
      name: details.type ?? "validation_error",
      message: details.message
    };
  },
  promptHints: [
    "This is the Resend Email API.",
    "The standard response for sending an email is a single object with an 'id' string."
  ],
  scenarios: resendScenarios,
  conformanceFixtures: resendConformanceFixtures
};

function readResendRequest(value: unknown): ResendRequest {
  if (!isJsonObject(value) || !isJsonObject(value.body)) return { body: {} };
  return { body: value.body };
}

function validationError(field: string): ProviderErrorDetails {
  return { status: 400, message: `Missing required field: ${field}`, type: "validation_error" };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isMutation(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}
