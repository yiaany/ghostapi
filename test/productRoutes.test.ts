import { rm } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server/createServer.js";
import { getFaultLabConfig, resetFaultLabForTests } from "../src/fault/faultLab.js";
import type { ServerConfig } from "../src/config/serverConfig.js";

const baseConfig = { host: "127.0.0.1", port: 8080, model: "gpt-4o-mini" } satisfies ServerConfig;

async function withServer<T>(test: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = await createServer(baseConfig);
  const server = app.listen(0);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  try {
    return await test(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

describe("product routes", () => {
  beforeEach(() => {
    resetFaultLabForTests();
  });

  afterAll(async () => {
    await rm(".ghostapi", { recursive: true, force: true });
  });

  it("serves one-click setup and scenario actions", async () => {
    await withServer(async (baseUrl) => {
      const setupResponse = await fetch(`${baseUrl}/api/setup`, { method: "POST" });
      const setup = await setupResponse.json();
      expect(setupResponse.status).toBe(200);
      expect(setup.files.some((file: { path: string }) => file.path === ".cursor/mcp.json")).toBe(true);

      const scenariosResponse = await fetch(`${baseUrl}/api/scenarios`);
      const scenarios = await scenariosResponse.json() as Array<{ id: string }>;
      expect(scenarios.map((scenario) => scenario.id)).toContain("github-issue-create");

      const replayResponse = await fetch(`${baseUrl}/api/scenarios/github-issue-create/replay`, { method: "POST" });
      expect(replayResponse.status).toBe(200);
      await expect(replayResponse.json()).resolves.toMatchObject({ applied: [{ method: "POST", path: "/repos/ghostapi/demo/issues", status: 201 }] });

      const promptResponse = await fetch(`${baseUrl}/api/agent-prompt`);
      await expect(promptResponse.json()).resolves.toMatchObject({ title: "GhostAPI Agent Prompt" });

      const importResponse = await fetch(`${baseUrl}/api/scenarios`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Route custom", steps: [{ method: "GET", path: "/route", status: 200, body: { ok: true } }] }) });
      expect(importResponse.status).toBe(201);

      await fetch(`${baseUrl}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Test" }) });
      const events = await (await fetch(`${baseUrl}/api/events`)).json() as Array<{ id: string }>;
      const testResponse = await fetch(`${baseUrl}/api/events/${events.at(-1)!.id}/test`);
      await expect(testResponse.json()).resolves.toMatchObject({ filename: expect.stringContaining("post-tasks") });

      const saveResponse = await fetch(`${baseUrl}/api/scenarios/save-from-traffic`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Saved Smoke" }) });
      expect(saveResponse.status).toBe(201);

      const reportResponse = await fetch(`${baseUrl}/api/safety-report`);
      expect(reportResponse.status).toBe(200);
    });
  });

  it("blocks cross-origin dashboard API mutations", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/fault-lab`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ enabled: true })
      });

      expect(response.status).toBe(403);
      expect(getFaultLabConfig().enabled).toBe(false);
    });
  });
});
