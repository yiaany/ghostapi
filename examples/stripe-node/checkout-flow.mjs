import Stripe from "stripe";

const host = process.env.GHOSTAPI_HOST ?? "127.0.0.1";
const port = Number(process.env.GHOSTAPI_PORT ?? "8080");
const protocol = process.env.GHOSTAPI_PROTOCOL ?? "http";
const baseUrl = `${protocol}://${host}:${port}`;
const webhookSecret = process.env.GHOSTAPI_STRIPE_WEBHOOK_SECRET ?? "whsec_ghostapi_local_test_secret";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_ghostapi_local_only", {
  host,
  port,
  protocol,
  apiVersion: "2026-02-25.clover"
});

const customer = await stripe.customers.create({
  email: "ada@example.com",
  name: "Ada Lovelace",
  metadata: { example: "ghostapi-subscription-flow" }
});

const product = await stripe.products.create({ name: "GhostAPI Pro" });
const price = await stripe.prices.create({
  product: product.id,
  currency: "usd",
  unit_amount: 2500,
  recurring: { interval: "month" }
});

const subscription = await stripe.subscriptions.create({
  customer: customer.id,
  items: [{ price: price.id }],
  trial_period_days: 7
});

// The renewal action is a GhostAPI local test control, not a live Stripe endpoint.
const renewalResponse = await fetch(`${baseUrl}/v1/subscriptions/${subscription.id}/renew`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({})
});
const renewed = await renewalResponse.json();

const events = await stripe.events.list({ limit: 20 });
const event = events.data.find((candidate) => candidate.type === "invoice.payment_succeeded");
if (event === undefined) throw new Error("Expected a local invoice.payment_succeeded webhook event.");

const delivery = await fetch(`${baseUrl}/v1/events/${event.id}/deliver?delivery_mode=duplicate`);
const payload = await delivery.text();
const signature = delivery.headers.get("stripe-signature");
if (signature === null) throw new Error("GhostAPI webhook delivery did not include stripe-signature.");
const verifiedEvent = stripe.webhooks.constructEvent(payload, signature, webhookSecret);

console.log(JSON.stringify({
  customer: customer.id,
  product: product.id,
  price: price.id,
  trialSubscription: subscription.id,
  renewedSubscription: renewed.id,
  verifiedWebhook: { id: verifiedEvent.id, type: verifiedEvent.type }
}, null, 2));
