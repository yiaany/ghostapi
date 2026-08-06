# Stripe Core Pack

The built-in Stripe core pack is a deterministic local simulation for the most common payment workflows. It is not full Stripe compatibility and it never makes outbound network requests.

## Version And Verification

- Verified against Stripe's official API reference and Stripe Node SDK behavior on 2026-08-06.
- GhostAPI compatibility API version: `2026-02-25.clover`.
- Pack version: `1.0.0`.
- Successful pack responses include `x-ghostapi-provider-pack: stripe@1.0.0`, `stripe-version: 2026-02-25.clover`, and a deterministic `request-id`.

The version is an explicit GhostAPI compatibility contract, not a claim that all live Stripe endpoints or fields are supported.

## Supported Operations

| Resource | Operations |
| --- | --- |
| Customers | Create, retrieve, update, delete, list |
| Payment Intents | Create, retrieve, update, confirm, list |
| Payment Methods | Create minimal `card` method, retrieve, list |
| Checkout Sessions | Create, retrieve, list |
| Refunds | Create, retrieve, list |

List endpoints return Stripe-shaped `{ object: "list", data, has_more, url }` responses and accept `limit`, `starting_after`, and `ending_before` cursors.

The pack accepts form-encoded nested parameters such as `metadata[source]=sdk` and `line_items[0][price_data][unit_amount]=2500`, as emitted by the Stripe Node SDK. JSON bodies are accepted for direct local clients.

## Determinism And State

Objects receive deterministic IDs, timestamps, and request IDs when a fixed runtime clock and ID generator are injected in tests. Normal runtime IDs remain unique across requests. Stateful requests run under GhostAPI's local atomic state transaction; the pack does not access storage itself.

`Idempotency-Key` is represented only by a SHA-256-derived local digest in events and state. A repeated mutation with the same key and parameters returns the original response with `x-ghostapi-idempotency: REPLAY`. Reusing the key with different parameters returns a Stripe-shaped `idempotency_error`.

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

- Subscriptions, invoices, disputes, webhooks, Connect, payment links, Setup Intents, and all other endpoints are unsupported.
- Unsupported operations return a diagnostic `invalid_request_error`; GhostAPI does not generate a fake success.
- Checkout Sessions are local objects. Their returned URL is a local placeholder and not a hosted checkout page.
- Payment Intent confirmation has a simplified state model: normal confirmation succeeds; the documented decline token fails.
- Refunds support `payment_intent` or `charge` input, but only validate a referenced Payment Intent when one is supplied.
- No live keys, PANs, CVCs, provider credentials, or real network traffic are retained or used.

## Runnable SDK Example

Start GhostAPI and run `examples/stripe-node/checkout-flow.mjs`. The example configures the official Node SDK with its documented host, port, protocol, and API-version client options; no SDK source patch is required.
