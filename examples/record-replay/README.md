# Record/Replay Starter

This starter uses a tiny sanitized HAR fixture and a matching request file. It demonstrates the workflow without a live provider key.

```bash
npx @yiaany/ghostapi record \
  --input examples/record-replay/stripe-checkout.har.json \
  --allow-sandbox-host api.stripe.com \
  --out .ghostapi/scenarios/stripe-checkout.bundle.json \
  --title "Starter checkout" \
  --approve

npx @yiaany/ghostapi replay \
  .ghostapi/scenarios/stripe-checkout.bundle.json \
  --requests examples/record-replay/replay-requests.json \
  --json
```

The fixture uses a fake `sk_test_...` key marker; do not record production traffic.
