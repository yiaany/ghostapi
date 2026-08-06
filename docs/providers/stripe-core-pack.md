# Stripe Core Pack

The built-in Stripe core pack is a deterministic local simulation for the most common payment workflows. It is not full Stripe compatibility and it never makes outbound network requests.

## Version And Verification

- Verified against Stripe's official API reference and Stripe Node SDK behavior on 2026-08-06.
- GhostAPI compatibility API version: `2026-02-25.clover`.
- Pack version: `1.1.0`.
- Successful pack responses include `x-ghostapi-provider-pack: stripe@1.1.0`, `stripe-version: 2026-02-25.clover`, and a deterministic `request-id`.

The version is an explicit GhostAPI compatibility contract, not a claim that all live Stripe endpoints or fields are supported.

## Supported Operations

| Resource | Operations |
| --- | --- |
| Customers | Create, retrieve, update, delete, list |
| Payment Intents | Create, retrieve, update, confirm, list |
| Payment Methods | Create minimal `card` method, retrieve, list |
| Checkout Sessions | Create, retrieve, list |
| Refunds | Create, retrieve, list |
| Products | Create, retrieve, update, list |
| Prices | Create recurring or one-time prices, retrieve, update, list |
| Subscriptions | Create, retrieve, update, cancel, local `renew` control, list |
| Invoices | Retrieve, pay, void, list |
| Events | List, retrieve, and local signed delivery |

List endpoints return Stripe-shaped `{ object: "list", data, has_more, url }` responses and accept `limit`, `starting_after`, and `ending_before` cursors.

The pack accepts form-encoded nested parameters such as `metadata[source]=sdk` and `line_items[0][price_data][unit_amount]=2500`, as emitted by the Stripe Node SDK. JSON bodies are accepted for direct local clients.

## Determinism And State

Objects receive deterministic IDs, timestamps, and request IDs when a fixed runtime clock and ID generator are injected in tests. Normal runtime IDs remain unique across requests. Stateful requests run under GhostAPI's local atomic state transaction; the pack does not access storage itself.

`Idempotency-Key` is represented only by a SHA-256-derived local digest in events and state. A repeated mutation with the same key and parameters returns the original response with `x-ghostapi-idempotency: REPLAY`. Reusing the key with different parameters returns a Stripe-shaped `idempotency_error`. Receipts expire after 24 hours, allowing a new mutation for the same key after the local retention window.

## Billing Lifecycle

Subscriptions use one recurring Price. Creating with `trial_period_days` creates a `trialing` subscription; `POST /v1/subscriptions/:id/renew` is a GhostAPI-only local test control that advances it. A normal renewal produces an Invoice, succeeded Payment Intent, and `active` subscription. `pm_card_chargeDeclined` produces a Stripe `card_error`, preserves an open Invoice, and sets the subscription to `past_due`; `POST /v1/invoices/:id/pay` can recover it. Cancellation marks the subscription `canceled`. Refunds create a `charge.refunded` event and update the local Payment Intent refund total.

## Webhook Testing

State transitions create persisted Stripe-shaped Events for subscription, invoice, payment-intent, and refund lifecycle changes. GhostAPI deliberately does not accept arbitrary webhook target URLs and never sends outbound webhook HTTP requests. Instead, tests pull a raw signed payload from:

```text
GET /v1/events/:event_id/deliver?delivery_mode=normal|duplicate|delayed|out_of_order|invalid_signature
```

The response includes `stripe-signature`, generated with HMAC-SHA256 over `timestamp.rawPayload`. The default local-only secret is `whsec_ghostapi_local_test_secret`; set `GHOSTAPI_STRIPE_WEBHOOK_SECRET` to use another test secret. The secret is not stored in state, events, scenarios, or responses. `duplicate` reliably returns the same event ID and payload on repeat calls, `delayed` accepts bounded `delay_ms` (0-10000), `out_of_order` reverses the event-list ordering, and `invalid_signature` corrupts the signature. Use the official `stripe.webhooks.constructEvent` verifier against the raw response body.

Rate-limit (`429` + `Retry-After`), bounded delay/timeout simulation, and `5xx` behavior remain controlled through GhostAPI Fault Lab. These are injected before pack execution, so a client retry with an idempotency key exercises the normal atomic replay path after the fault is disabled.

## Test Card Outcomes

Use the Stripe test payment-method identifier `pm_card_chargeDeclined` (or legacy `tok_chargeDeclined`) when creating or confirming a Payment Intent to receive:

```json
{
  "error": {
    "type": "card_error",
    "code": "card_declined",
    "decline_code": "generic_decline"
  }
}
```

No PAN or CVC is required. If a direct client submits card-like fields, GhostAPI masks them before event or snapshot persistence. The returned synthetic Payment Method exposes only fixed non-sensitive card metadata such as `last4`.

## Deliberate Limits

- Disputes, Connect, payment links, Setup Intents, hosted Checkout, tax, proration, dunning, smart retries, and most Stripe APIs remain unsupported.
- Unsupported operations return a diagnostic `invalid_request_error`; GhostAPI does not generate a fake success.
- Checkout Sessions are local objects. Their returned URL is a local placeholder and not a hosted checkout page.
- Payment Intent confirmation has a simplified state model: normal confirmation succeeds; the documented decline token fails.
- Refunds support `payment_intent` or `charge` input, but only validate a referenced Payment Intent when one is supplied.
- No live keys, PANs, CVCs, provider credentials, or real network traffic are retained or used.

## Runnable SDK Example

Start GhostAPI and run `examples/stripe-node/checkout-flow.mjs`. The example configures the official Node SDK with its documented host, port, protocol, and API-version client options, then verifies a locally delivered webhook using the SDK; no SDK source patch is required.
