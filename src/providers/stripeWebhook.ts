import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderErrorDetails } from "./types.js";
import type { NormalizedRequest } from "../proxy/requestNormalizer.js";

const DEFAULT_TEST_SECRET = "whsec_ghostapi_local_test_secret";
const MAX_DELIVERY_DELAY_MS = 10_000;

export type StripeWebhookDelivery = {
  mode:
    "normal" | "duplicate" | "delayed" | "out_of_order" | "invalid_signature";
  delayMs: number;
  error: ProviderErrorDetails | null;
};

export function getStripeWebhookTestSecret(): string | undefined {
  const configured = process.env.GHOSTAPI_STRIPE_WEBHOOK_SECRET?.trim();
  return configured === "" ? undefined : (configured ?? DEFAULT_TEST_SECRET);
}

export function createStripeWebhookSignature(
  payload: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const secret = getStripeWebhookTestSecret();
  if (secret === undefined) return `t=${now},v1=invalid`;
  const signature = createHmac("sha256", secret)
    .update(`${now}.${payload}`, "utf8")
    .digest("hex");
  return `t=${now},v1=${signature}`;
}

export function isStripeWebhookDeliveryRequest(
  request: NormalizedRequest,
): boolean {
  return (
    request.method === "GET" &&
    /^\/v1\/events\/evt_[^/]+\/deliver$/.test(request.path)
  );
}

export function readStripeWebhookDelivery(
  query: Record<string, unknown>,
): StripeWebhookDelivery {
  const mode =
    typeof query.delivery_mode === "string" ? query.delivery_mode : "normal";
  if (!isDeliveryMode(mode)) {
    return {
      mode: "normal",
      delayMs: 0,
      error: invalidDeliveryParam(
        "delivery_mode",
        "Use normal, duplicate, delayed, out_of_order, or invalid_signature.",
      ),
    };
  }

  const delayMs =
    query.delay_ms === undefined
      ? mode === "delayed"
        ? 250
        : 0
      : Number(query.delay_ms);
  if (
    !Number.isInteger(delayMs) ||
    delayMs < 0 ||
    delayMs > MAX_DELIVERY_DELAY_MS
  ) {
    return {
      mode,
      delayMs: 0,
      error: invalidDeliveryParam(
        "delay_ms",
        `Use an integer between 0 and ${MAX_DELIVERY_DELAY_MS}.`,
      ),
    };
  }

  return { mode, delayMs, error: null };
}

export function corruptStripeWebhookSignature(signature: string): string {
  const match = signature.match(/^(t=\d+,v1=)([a-f0-9]+)$/);
  if (match === null) return "t=0,v1=invalid";
  return `${match[1]}${"0".repeat(match[2].length)}`;
}

export function verifyStripeWebhookSignature(
  payload: string,
  signature: string,
  secret = getStripeWebhookTestSecret(),
): boolean {
  if (secret === undefined) return false;
  const match = signature.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
  if (match === null) return false;
  const expected = createHmac("sha256", secret)
    .update(`${match[1]}.${payload}`, "utf8")
    .digest("hex");
  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(match[2], "utf8"),
  );
}

function isDeliveryMode(value: string): value is StripeWebhookDelivery["mode"] {
  return (
    value === "normal" ||
    value === "duplicate" ||
    value === "delayed" ||
    value === "out_of_order" ||
    value === "invalid_signature"
  );
}

function invalidDeliveryParam(
  param: string,
  message: string,
): ProviderErrorDetails {
  return {
    status: 400,
    type: "invalid_request_error",
    code: "parameter_invalid_enum",
    param,
    message,
  };
}
