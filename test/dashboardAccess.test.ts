import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server/createServer.js";
import type { ServerConfig } from "../src/config/serverConfig.js";

const token = "test-dashboard-token-1234567890";
const remoteConfig = {
  host: "0.0.0.0",
  port: 8080,
  model: "gpt-4o-mini",
  authToken: token,
} satisfies ServerConfig;

async function withServer<T>(
  config: ServerConfig,
  test: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = await createServer(config);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP server address");
  try {
    return await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("dashboard access control", () => {
  it("fails closed when a remote bind has no strong token", async () => {
    await expect(
      createServer({ host: "0.0.0.0", port: 8080, model: "gpt-4o-mini" }),
    ).rejects.toThrow("requires GHOSTAPI_AUTH_TOKEN");
    await expect(
      createServer({
        host: "0.0.0.0",
        port: 8080,
        model: "gpt-4o-mini",
        authToken: "short",
      }),
    ).rejects.toThrow("at least 24 characters");
  });

  it("requires a token for dashboard APIs and SSE on remote binds", async () => {
    await withServer(remoteConfig, async (baseUrl) => {
      for (const path of [
        "/dashboard",
        "/dashboard/app.js",
        "/api/events",
        "/events",
        "/API/events/",
      ]) {
        const response = await fetch(`${baseUrl}${path}`, {
          redirect: "manual",
        });
        expect(response.status, path).toBe(401);
      }

      const authorized = await fetch(`${baseUrl}/api/events`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authorized.status).toBe(200);
    });
  });

  it("establishes an HttpOnly cookie only through the dashboard query-token bootstrap", async () => {
    await withServer(remoteConfig, async (baseUrl) => {
      const bootstrap = await fetch(
        `${baseUrl}/dashboard?token=${encodeURIComponent(token)}`,
        { redirect: "manual" },
      );
      const cookie = bootstrap.headers.get("set-cookie");

      expect(bootstrap.status).toBe(303);
      expect(bootstrap.headers.get("location")).toBe("/dashboard");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toContain(token + "&");

      const dashboard = await fetch(`${baseUrl}/dashboard`, {
        headers: { cookie: cookie!.split(";")[0]! },
      });
      expect(dashboard.status).toBe(200);

      const queryTokenOnApi = await fetch(
        `${baseUrl}/api/events?token=${encodeURIComponent(token)}`,
      );
      expect(queryTokenOnApi.status).toBe(401);
    });
  });

  it("rejects hostile origins even when a valid token is present", async () => {
    await withServer(remoteConfig, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/fault-lab`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ enabled: true }),
      });

      expect(response.status).toBe(403);
    });
  });

  it("rejects DNS-rebinding style origins on loopback", async () => {
    await withServer(
      { host: "127.0.0.1", port: 8080, model: "gpt-4o-mini" },
      async (baseUrl) => {
        const port = new URL(baseUrl).port;
        const response = await fetch(`${baseUrl}/api/events`, {
          headers: {
            host: `attacker.example:${port}`,
            origin: `http://attacker.example:${port}`,
          },
        });

        expect(response.status).toBe(403);
      },
    );
  });

  it("requires remote proxy authentication in every generation mode", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await withServer(
      { ...remoteConfig, allowExternalLlm: true, apiKey: "external-secret" },
      async (baseUrl) => {
        fetchSpy.mockClear();
        const response = await fetch(`${baseUrl}/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "test" }),
        });

        expect(response.status).toBe(401);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      },
    );
    fetchSpy.mockRestore();

    await withServer(remoteConfig, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "local" }),
      });
      expect(response.status).toBe(401);
      const authorized = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "local" }),
      });
      expect(authorized.status).toBe(200);
    });
  });
});
