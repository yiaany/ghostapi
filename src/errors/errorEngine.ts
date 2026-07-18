import type { NormalizedRequest } from "../proxy/requestNormalizer.js";
import type { ProviderName, ProviderErrorDetails } from "../providers/types.js";
import { isJsonObject } from "../utils/json.js";

export function validateRequest(request: NormalizedRequest, provider: ProviderName): ProviderErrorDetails | null {
  if (provider === "stripe") {
    return validateStripe(request);
  }

  if (provider === "twilio") {
    return validateTwilio(request);
  }

  if (provider === "resend") {
    return validateResend(request);
  }

  return null;
}

function validateStripe(request: NormalizedRequest): ProviderErrorDetails | null {
  if (request.method !== "POST") return null;

  const body = isJsonObject(request.body) ? request.body : Object.fromEntries(new URLSearchParams(String(request.body)));
  
  if (request.path.includes("/charges") || request.path.includes("/payment_intents")) {
    if (!body["amount"]) {
      return { status: 400, message: "Missing required param: amount.", type: "invalid_request_error", code: "parameter_missing", param: "amount" };
    }
    if (!body["currency"]) {
      return { status: 400, message: "Missing required param: currency.", type: "invalid_request_error", code: "parameter_missing", param: "currency" };
    }
  }

  if (request.path.includes("/customers") && Object.keys(body).length === 0) {
    return { status: 400, message: "Missing required param: email or description.", type: "invalid_request_error", code: "parameter_missing", param: "email" };
  }

  return null;
}

function validateTwilio(request: NormalizedRequest): ProviderErrorDetails | null {
  if (request.method !== "POST") return null;

  const body = Array.isArray(request.body) ? {} : isJsonObject(request.body) ? request.body : Object.fromEntries(new URLSearchParams(String(request.body)));

  if (request.path.includes("/Messages.json")) {
    if (!body["To"]) {
      return { status: 400, message: "A 'To' phone number is required.", code: 21604 };
    }
    if (!body["From"] && !body["MessagingServiceSid"]) {
      return { status: 400, message: "A 'From' phone number is required.", code: 21603 };
    }
    if (!body["Body"] && !body["MediaUrl"]) {
      return { status: 400, message: "Message body is required.", code: 21602 };
    }
  }

  return null;
}

function validateResend(request: NormalizedRequest): ProviderErrorDetails | null {
  if (request.method !== "POST") return null;

  const body = isJsonObject(request.body) ? request.body : {};

  if (request.path === "/emails" || request.path.startsWith("/emails/")) {
    if (!body["from"]) {
      return { status: 400, message: "Missing required field: from", type: "validation_error" };
    }
    if (!body["to"]) {
      return { status: 400, message: "Missing required field: to", type: "validation_error" };
    }
    if (!body["subject"]) {
      return { status: 400, message: "Missing required field: subject", type: "validation_error" };
    }
  }

  return null;
}