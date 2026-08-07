import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importOpenApiContractFromFile, diffContracts, importHarContract, importOpenApiContract } from "../src/contracts/index.js";
import { getDataPaths } from "../src/config/dataPaths.js";

describe("contract import and drift", () => {
  it("imports the documented OpenAPI 3.0 JSON subset deterministically without resolving URLs", () => {
    const input = {
      openapi: "3.0.3",
      info: { title: "Orders" },
      paths: {
        "/orders": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["status"],
                    properties: { status: { type: "string", enum: ["draft", "paid"] } }
                  }
                }
              }
            },
            responses: {
              "201": { description: "created", content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } } }
            }
          }
        }
      }
    };

    const first = importOpenApiContract(input, { importedAt: "2026-08-07T00:00:00.000Z" });
    const second = importOpenApiContract(input, { importedAt: "2026-08-07T00:00:00.000Z" });

    expect(first).toEqual(second);
    expect(first.operations).toMatchObject([{ method: "POST", path: "/orders", request: { required: ["status"] }, responses: { "201": { required: ["id"] } } }]);
  });

  it("rejects external refs and recursion-depth schema bombs before any network access", async () => {
    const remoteRef = JSON.parse(await readFixture("openapi-malicious-remote-ref.json"));
    const schemaBomb = JSON.parse(await readFixture("openapi-schema-bomb.json"));

    expect(() => importOpenApiContract(remoteRef)).toThrow(/\$ref.*never fetched/i);
    expect(() => importOpenApiContract(schemaBomb)).toThrow("recursion depth");
  });

  it("rejects compressed archives before decompression or parser work", async () => {
    await mkdir(getDataPaths().root, { recursive: true });
    const archivePath = join(getDataPaths().root, "openapi.json.gz");
    await writeFile(archivePath, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));

    await expect(importOpenApiContractFromFile(archivePath)).rejects.toThrow("archive input is unsupported");
  });

  it("derives HAR contracts only after the shared scenario sanitizer has removed sensitive input", () => {
    const { bundle, contract } = importHarContract({
      log: {
        entries: [{
          request: { method: "POST", url: "https://api.sandbox.example/orders", headers: [{ name: "authorization", value: "Bearer sk_test_secret" }, { name: "content-type", value: "application/json" }], postData: { mimeType: "application/json", text: "{\"email\":\"ada@example.com\",\"amount\":1}" } },
          response: { status: 201, headers: [{ name: "content-type", value: "application/json" }], content: { mimeType: "application/json", text: "{\"id\":\"ord_captured\",\"status\":\"paid\"}" } }
        }]
      }
    }, { allowedSandboxHosts: ["api.sandbox.example"], importedAt: "2026-08-07T00:00:00.000Z" });

    expect(JSON.stringify(bundle)).not.toContain("sk_test_secret");
    expect(JSON.stringify(contract)).not.toContain("ada@example.com");
    expect(contract.metadata.source).toBe("har");
    expect(contract.operations[0]).toMatchObject({ method: "POST", path: "/orders", responses: { "201": { type: "object" } } });
  });

  it("classifies endpoint, required-field, enum, status, type, and provider capability changes deterministically", () => {
    const baseline = contract("Baseline", [{
      method: "POST",
      path: "/orders",
      request: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["draft", "paid"] }, amount: { type: "integer" } } },
      responses: { "200": { type: "object", required: ["id"], properties: { id: { type: "string" }, state: { type: "string" } } }, "202": { type: "object" } }
    }], [{ name: "stripe", packVersion: "1.0.0", capabilities: { webhooks: true, validation: true } }]);
    const candidate = contract("Candidate", [{
      method: "POST",
      path: "/orders",
      request: { type: "object", required: ["status", "currency"], properties: { status: { type: "string", enum: ["draft"] }, amount: { type: "string" }, currency: { type: "string" } } },
      responses: { "200": { type: "object", required: ["id"], properties: { id: { type: "string" }, new_state: { type: "string" } } }, "201": { type: "object" } }
    }, { method: "GET", path: "/health", responses: { "200": { type: "object" } } }], [{ name: "stripe", packVersion: "1.1.0", capabilities: { webhooks: false, validation: true } }]);

    const diff = diffContracts(baseline, candidate);

    expect(diff).toMatchSnapshot();
    expect(diff.findings.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "endpoint-added:GET /health",
      "required-field-added:POST /orders request.currency",
      "enum-value-removed:POST /orders request.status.\"paid\"",
      "schema-type-changed:POST /orders request.amount",
      "response-status-removed:POST /orders 202",
      "property-removed:POST /orders response 200.state",
      "provider-capability-changed:stripe.webhooks"
    ]));
    expect(diff.summary.breaking).toBeGreaterThan(0);
    expect(diff.summary.uncertain).toBeGreaterThan(0);
  });
});

function contract(title: string, operations: unknown[], providerCapabilities: unknown[]) {
  return {
    schemaVersion: 1 as const,
    kind: "ghostapi.contract" as const,
    metadata: { title, source: "openapi" as const, importedAt: "2026-08-07T00:00:00.000Z" },
    operations,
    providerCapabilities
  } as Parameters<typeof diffContracts>[0];
}

async function readFixture(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}
