const baseUrl = process.env.GHOSTAPI_BASE_URL;

if (!baseUrl) throw new Error("GHOSTAPI_BASE_URL is required; run this fixture through ghostapi run.");

const response = await fetch(`${baseUrl}/v1/customers`, {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify({
    email: "ci-safe@example.invalid",
    metadata: { scenario: "ci.safe_ghostapi" }
  })
});

if (!response.ok) throw new Error(`GhostAPI safe fixture failed with HTTP ${response.status}.`);
console.log("GhostAPI safe fixture completed through the loopback runtime.");
