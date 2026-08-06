# Stripe Node Checkout Flow

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

Run the checkout flow:

```bash
node checkout-flow.mjs
```

The script creates a customer, confirmed Payment Intent, Checkout Session, and refund, then prints their IDs.

The core pack accepts SDK-style `application/x-www-form-urlencoded` requests and JSON requests used by direct HTTP clients. It uses Stripe API version `2026-02-25.clover`.

To inspect the generated state:

```bash
curl http://127.0.0.1:8080/v1/payment_intents?limit=10
```

See [`docs/providers/stripe-core-pack.md`](../../docs/providers/stripe-core-pack.md) for supported operations and deliberate limits.
