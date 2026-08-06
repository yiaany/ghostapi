import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_ghostapi_local_only", {
  host: process.env.GHOSTAPI_HOST ?? "127.0.0.1",
  port: Number(process.env.GHOSTAPI_PORT ?? "8080"),
  protocol: process.env.GHOSTAPI_PROTOCOL ?? "http",
  apiVersion: "2026-02-25.clover"
});

const customer = await stripe.customers.create({
  email: "ada@example.com",
  name: "Ada Lovelace",
  metadata: { example: "ghostapi-checkout-flow" }
});

const paymentIntent = await stripe.paymentIntents.create({
  amount: 2500,
  currency: "usd",
  customer: customer.id,
  confirm: true
}, { idempotencyKey: "ghostapi-checkout-flow-payment-intent" });

const checkoutSession = await stripe.checkout.sessions.create({
  mode: "payment",
  customer: customer.id,
  success_url: "https://example.test/success",
  cancel_url: "https://example.test/cancel",
  line_items: [{
    quantity: 1,
    price_data: {
      currency: "usd",
      unit_amount: 2500,
      product_data: { name: "GhostAPI demo" }
    }
  }]
});

const refund = await stripe.refunds.create({ payment_intent: paymentIntent.id });

console.log(JSON.stringify({
  customer: customer.id,
  paymentIntent: paymentIntent.id,
  checkoutSession: checkoutSession.id,
  refund: refund.id
}, null, 2));
