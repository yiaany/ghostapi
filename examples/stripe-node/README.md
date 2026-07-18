# Stripe Node Example

Create and fetch a Stripe-like customer through GhostAPI. This does not call Stripe.

## Run

Start GhostAPI:

```bash
ghostapi start
```

Create a customer:

```bash
curl -X POST http://localhost:8080/v1/customers \
  -H "content-type: application/json" \
  -H "authorization: Bearer stripe_test_local_only" \
  -d '{"email":"ada@example.com","name":"Ada Lovelace","metadata":{"source":"ghostapi-example"}}'
```

Copy the returned `id`, then fetch it:

```bash
curl http://localhost:8080/v1/customers/cus_mock_example \
  -H "authorization: Bearer stripe_test_local_only"
```

GhostAPI detects Stripe from the `/v1/customers` path and keeps the created object in `.ghostapi/state.json`.
