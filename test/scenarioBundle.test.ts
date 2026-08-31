import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { getDataPaths } from "../src/config/dataPaths.js";
import {
  createScenarioReplayer,
  loadScenarioBundle,
  migrateScenarioBundle,
  prepareScenarioRecording,
  prepareScenarioRecordingFromFile,
  ScenarioBundleError,
  validateScenarioBundle,
  writeScenarioBundle,
} from "../src/scenarios/scenarioBundle.js";

const cliPath = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

describe("scenario bundles", () => {
  beforeEach(async () => {
    await writeFile(getDataPaths().events, "", { encoding: "utf8" }).catch(
      () => undefined,
    );
  });

  it("structurally sanitizes nested secrets and configurable PII before writing a portable bundle", async () => {
    const bundle = prepareScenarioRecording(captureFixture(), {
      title: "Stripe sandbox order",
      allowedSandboxHosts: ["api.stripe.com"],
      recordedAt: "2026-08-07T00:00:00.000Z",
    });
    const path = await writeScenarioBundle(bundle);
    const saved = await readFile(path, "utf8");

    expect(bundle.sanitization).toMatchObject({ requiresApproval: true });
    expect(bundle.sanitization.categories).toEqual(
      expect.arrayContaining([
        "authorization",
        "cookie",
        "email",
        "phone",
        "address",
        "known-api-key",
        "unstable-id",
        "timestamp",
      ]),
    );
    expect(bundle.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "cus_recorded_1" }),
      ]),
    );
    expect(saved).not.toContain("Bearer sk_test_capture_secret");
    expect(saved).not.toContain("session=private");
    expect(saved).not.toContain("ada@example.com");
    expect(saved).not.toContain("+1 415 555 1212");
    expect(saved).not.toContain("500 Market Street");
    expect(saved).not.toContain("sk_live_nested_secret");
    await expect(loadScenarioBundle(path)).resolves.toMatchObject({
      schemaVersion: 1,
      metadata: { sandboxHosts: ["api.stripe.com"] },
    });
  });

  it("omits multipart and binary payloads and blocks external redirect capture", () => {
    const bundle = prepareScenarioRecording(
      {
        interactions: [
          {
            request: {
              method: "POST",
              url: "https://payments.sandbox.example/upload",
              headers: {
                "content-type": "multipart/form-data; boundary=abc",
                authorization: "Bearer test-secret",
              },
              body: "------abc\r\nprivate attachment bytes",
            },
            response: {
              status: 302,
              headers: {
                location: "https://outside.example/redirect",
                "content-type": "application/octet-stream",
              },
              body: "AAECAw==",
              bodyEncoding: "base64",
            },
          },
        ],
      },
      { allowedSandboxHosts: ["payments.sandbox.example"] },
    );

    expect(bundle.interactions[0]?.request.body).toBe(
      "[GhostAPI omitted binary payload]",
    );
    expect(bundle.interactions[0]?.response.body).toBe(
      "[GhostAPI omitted binary payload]",
    );
    expect(bundle.interactions[0]?.response.headers.location).toBe(
      "/__ghostapi_redirect_blocked__",
    );
    expect(bundle.sanitization.categories).toEqual(
      expect.arrayContaining([
        "binary-payload",
        "external-redirect",
        "authorization",
      ]),
    );
  });

  it("rejects unapproved production-looking hosts, missing sandbox proof, and oversized traffic", () => {
    expect(() =>
      prepareScenarioRecording(
        {
          interactions: [
            {
              request: {
                method: "GET",
                url: "https://api.stripe.com/v1/customers",
                headers: {},
              },
              response: { status: 200 },
            },
          ],
        },
        { allowedSandboxHosts: ["api.stripe.com"] },
      ),
    ).toThrow("sandbox safety check");

    expect(() =>
      prepareScenarioRecording(
        {
          interactions: [
            {
              request: {
                method: "GET",
                url: "https://api.live.example/orders",
                headers: {},
              },
              response: { status: 200 },
            },
          ],
        },
        { allowedSandboxHosts: ["api.live.example"] },
      ),
    ).toThrow("sandbox safety check");

    expect(() =>
      prepareScenarioRecording(
        {
          interactions: [
            {
              request: {
                method: "POST",
                url: "https://api.sandbox.example/orders",
                headers: {},
                body: "x".repeat(1024 * 1024),
              },
              response: { status: 201 },
            },
          ],
        },
        { allowedSandboxHosts: ["api.sandbox.example"] },
      ),
    ).toThrow("exceeds");
  });

  it("replays stateful variables and repeated requests deterministically without network access", () => {
    const bundle = prepareScenarioRecording(
      {
        interactions: [
          {
            request: {
              method: "POST",
              url: "https://api.sandbox.example/orders",
              headers: { "content-type": "application/json" },
              body: { customer_id: "cus_livecapture" },
            },
            response: {
              status: 201,
              headers: { "content-type": "application/json" },
              body: { id: "ord_livecapture", customer_id: "cus_livecapture" },
            },
          },
          {
            request: {
              method: "GET",
              url: "https://api.sandbox.example/orders/ord_livecapture",
              headers: {},
            },
            response: {
              status: 200,
              headers: { "content-type": "application/json" },
              body: { id: "ord_livecapture", status: "paid" },
            },
          },
        ],
      },
      { allowedSandboxHosts: ["api.sandbox.example"] },
    );
    const replayer = createScenarioReplayer(bundle);

    const created = replayer.replay({
      method: "POST",
      path: "/orders",
      headers: { "content-type": "application/json" },
      body: { customer_id: "cus_livecapture" },
    });
    const orderId = (created.body as { id: string }).id;
    expect(created).toMatchObject({
      status: 201,
      body: { customer_id: "cus_livecapture" },
    });
    expect(
      replayer.replay({ method: "GET", path: `/orders/${orderId}` }),
    ).toMatchObject({ status: 200, body: { id: orderId } });
    expect(replayer.remaining).toBe(0);
  });

  it("does not silently choose a later or ambiguous match", () => {
    const bundle = prepareScenarioRecording(
      {
        interactions: [
          {
            request: {
              method: "GET",
              url: "https://api.sandbox.example/one",
              headers: {},
            },
            response: { status: 200, body: { step: 1 } },
          },
          {
            request: {
              method: "GET",
              url: "https://api.sandbox.example/two",
              headers: {},
            },
            response: { status: 200, body: { step: 2 } },
          },
        ],
      },
      { allowedSandboxHosts: ["api.sandbox.example"] },
    );
    const replayer = createScenarioReplayer(bundle);

    expect(() => replayer.replay({ method: "GET", path: "/two" })).toThrow(
      "sequence-strict",
    );
    expect(replayer.replay({ method: "GET", path: "/one" })).toMatchObject({
      index: 1,
    });
  });

  it("accepts HAR entries and preserves repeated calls in recorded order", () => {
    const bundle = prepareScenarioRecording(
      {
        log: {
          entries: [
            {
              request: {
                method: "GET",
                url: "https://api.sandbox.example/health",
                headers: [],
              },
              response: {
                status: 200,
                headers: [{ name: "content-type", value: "application/json" }],
                content: {
                  mimeType: "application/json",
                  text: '{"attempt":1}',
                },
              },
            },
            {
              request: {
                method: "GET",
                url: "https://api.sandbox.example/health",
                headers: [],
              },
              response: {
                status: 503,
                headers: [{ name: "content-type", value: "application/json" }],
                content: {
                  mimeType: "application/json",
                  text: '{"attempt":2}',
                },
              },
            },
          ],
        },
      },
      { allowedSandboxHosts: ["api.sandbox.example"] },
    );
    const replayer = createScenarioReplayer(bundle);

    expect(replayer.replay({ method: "GET", path: "/health" })).toMatchObject({
      status: 200,
      body: { attempt: 1 },
    });
    expect(replayer.replay({ method: "GET", path: "/health" })).toMatchObject({
      status: 503,
      body: { attempt: 2 },
    });
  });

  it("rejects executable and secret-bearing bundle fields and non-symlink input only", async () => {
    expect(() =>
      validateScenarioBundle({
        schemaVersion: 1,
        kind: "ghostapi.scenario-bundle",
        metadata: {
          title: "Bad",
          recordedAt: "2026-08-07T00:00:00.000Z",
          sandboxHosts: ["api.sandbox.example"],
        },
        sanitization: {
          categories: [],
          replacements: 0,
          requiresApproval: false,
        },
        variables: [],
        interactions: [
          {
            request: { method: "GET", path: "/x", headers: {}, body: {} },
            response: {
              status: 200,
              headers: {},
              body: { authorization: "Bearer leaked" },
            },
            hook: "process.exit()",
          },
        ],
      }),
    ).toThrow("unknown field");

    const capturePath = join(getDataPaths().root, "capture.json");
    await mkdir(getDataPaths().root, { recursive: true });
    await writeFile(capturePath, JSON.stringify(captureFixture()), "utf8");
    await expect(
      prepareScenarioRecordingFromFile(capturePath, {
        allowedSandboxHosts: ["api.stripe.com"],
      }),
    ).resolves.toMatchObject({ schemaVersion: 1 });
    await expect(
      prepareScenarioRecordingFromFile("../outside.json", {
        allowedSandboxHosts: ["api.stripe.com"],
      }),
    ).rejects.toThrow("path traversal");
  });

  it("migrates the declared v0 layout into v1 and marks it for review", () => {
    const recorded = prepareScenarioRecording(
      {
        interactions: [
          {
            request: {
              method: "GET",
              url: "https://api.sandbox.example/health",
              headers: {},
            },
            response: { status: 200, body: { ok: true } },
          },
        ],
      },
      {
        allowedSandboxHosts: ["api.sandbox.example"],
        recordedAt: "2026-08-07T00:00:00.000Z",
      },
    );
    const migrated = validateScenarioBundle(
      migrateScenarioBundle({
        schemaVersion: 0,
        kind: "ghostapi.scenario-bundle",
        title: recorded.metadata.title,
        recordedAt: recorded.metadata.recordedAt,
        sandboxHosts: recorded.metadata.sandboxHosts,
        variables: recorded.variables,
        interactions: recorded.interactions,
      }),
    );

    expect(migrated).toMatchObject({
      schemaVersion: 1,
      sanitization: { categories: ["legacy-bundle"], requiresApproval: true },
    });
  });

  it("requires explicit CLI approval before writing a bundle with sensitive categories", async () => {
    const capturePath = join(getDataPaths().root, "approval-capture.json");
    const outputPath = join(getDataPaths().scenarios, "approved.bundle.json");
    await mkdir(getDataPaths().root, { recursive: true });
    await writeFile(capturePath, JSON.stringify(captureFixture()), "utf8");

    const denied = await runCli([
      "record",
      "--input",
      capturePath,
      "--allow-sandbox-host",
      "api.stripe.com",
      "--out",
      outputPath,
    ]);
    expect(denied.exitCode).toBe(1);
    expect(denied.stdout).toContain("Approval required: yes");
    await expect(access(outputPath, constants.F_OK)).rejects.toThrow();

    const approved = await runCli([
      "record",
      "--input",
      capturePath,
      "--allow-sandbox-host",
      "api.stripe.com",
      "--out",
      outputPath,
      "--approve",
    ]);
    expect(approved.exitCode).toBe(0);
    expect(approved.stdout).toContain("Bundle:");
    await expect(loadScenarioBundle(outputPath)).resolves.toMatchObject({
      schemaVersion: 1,
    });
  });
});

function captureFixture() {
  return {
    interactions: [
      {
        request: {
          method: "POST",
          url: "https://api.stripe.com/v1/customers?api_key=sk_test_query_secret",
          headers: {
            authorization: "Bearer sk_test_capture_secret",
            cookie: "session=private",
            "content-type": "application/json",
          },
          body: {
            id: "cus_livecapture",
            email: "ada@example.com",
            phone: "+1 415 555 1212",
            address: {
              line1: "500 Market Street",
              city: "San Francisco",
              postal_code: "94105",
            },
            nested: { api_key: "sk_live_nested_secret" },
            created_at: "2026-08-07T10:11:12.000Z",
          },
        },
        response: {
          status: 201,
          headers: { "content-type": "application/json" },
          body: { id: "cus_livecapture", object: "customer" },
        },
      },
    ],
  };
}

function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr }),
    );
  });
}
