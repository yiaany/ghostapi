# Stripe Node Subscription Flow

Run the official Stripe Node SDK against GhostAPI without patching SDK source. This example only talks to `127.0.0.1`; it does not call Stripe.

## Run

Start GhostAPI:

```bash
ghostapi start
```

Install the SDK once in this example directory:

```bash
npm install stripe
```

Run the subscription flow:

```bash
node checkout-flow.mjs
```

The script creates a customer, product, recurring price, and trial subscription; activates the local renewal control; then verifies the signed `invoice.payment_succeeded` payload with the official Stripe SDK. `delivery_mode=duplicate` deliberately returns the same event again so application-level de-duplication can be tested.

The pack accepts SDK-style `application/x-www-form-urlencoded` requests and JSON requests used by direct HTTP clients. It uses Stripe API version `2026-02-25.clover`. Webhook deliveries are pull-based local test endpoints, so this example never asks GhostAPI to send an outbound request.

To inspect the generated state:

```bash
curl http://127.0.0.1:8080/v1/payment_intents?limit=10
```

See [`docs/providers/stripe-core-pack.md`](../../docs/providers/stripe-core-pack.md) for supported operations and deliberate limits.
