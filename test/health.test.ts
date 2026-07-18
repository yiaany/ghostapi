import { describe, expect, it } from "vitest";
import { createServer } from "../src/server/createServer.js";

describe("health route", () => {
  it("returns ok", async () => {
    const app = await createServer({ host: "127.0.0.1", port: 8080, model: "gpt-4o-mini" });
    const server = app.listen(0);
    const address = server.address();

    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Expected TCP server address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(response.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
