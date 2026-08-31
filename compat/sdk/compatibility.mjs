import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const dataDir = await mkdtemp(join(tmpdir(), "ghostapi-sdk-compat-"));
process.env.GHOSTAPI_DATA_DIR = dataDir;

const { createServer } = await import("../../dist/index.js");
const app = await createServer({
  host: "127.0.0.1",
  port: 0,
  model: "gpt-4o-mini",
  offline: true,
});
const server = app.listen(0, "127.0.0.1");
const originalConnect = Socket.prototype.connect;

try {
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  Socket.prototype.connect = function (...args) {
    let options = args[0];
    while (Array.isArray(options)) [options] = options;
    assert(
      options && typeof options === "object" && !Array.isArray(options),
      "SDK compatibility fixture blocked a non-TCP socket connection",
    );
    assert.equal(
      options.host,
      "127.0.0.1",
      `SDK compatibility fixture blocked non-loopback host ${String(options.host)}`,
    );
    assert.equal(
      Number(options.port),
      address.port,
      `SDK compatibility fixture blocked unexpected port ${String(options.port)}`,
    );
    return Reflect.apply(originalConnect, this, args);
  };

  assert.throws(
    () => new Socket().connect({ host: "api.stripe.com", port: 443 }),
    /blocked non-loopback host/,
  );
  assert.throws(
    () => new Socket().connect({ host: "127.0.0.1", port: address.port + 1 }),
    /blocked unexpected port/,
  );

  const OpenAI = require("openai").default;
  const Stripe = require("stripe");

  const stripe = new Stripe("stripe_test_ghostapi", {
    apiVersion: "2026-02-25.clover",
    host: "127.0.0.1",
    port: address.port,
    protocol: "http",
    maxNetworkRetries: 0,
    timeout: 5_000,
  });
  const customer = await stripe.customers.create({
    email: "sdk-compat@example.com",
  });
  assert.equal(customer.object, "customer");
  assert.match(customer.id, /^cus_/);

  const openai = new OpenAI({
    apiKey: "sk-ghostapi",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    maxRetries: 0,
    timeout: 5_000,
  });
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "user", content: "Return a local compatibility response." },
    ],
  });
  assert.equal(completion.object, "chat.completion");
  assert.ok(completion.choices.length > 0);

  console.log("PASS official Stripe 22.6.0 and OpenAI 7.8.0 SDK compatibility");
} finally {
  Socket.prototype.connect = originalConnect;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
