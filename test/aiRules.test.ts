import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { generateAiRules } from "../src/rules/aiRules.js";

let tempDir: string | null = null;

describe("AI rules generation", () => {
  afterEach(async () => {
    if (tempDir !== null) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("generates Stripe host override instructions from package.json", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ghostapi-rules-"));
    await writeFile(join(tempDir, "package.json"), JSON.stringify({ dependencies: { stripe: "^18.0.0" } }), "utf8");

    const result = await generateAiRules(tempDir);

    expect(result.filename).toBe(".cursorrules");
    expect(result.detected).toEqual(["stripe"]);
    expect(result.content).toContain("host: process.env.GHOSTAPI_HOST");
    expect(result.content).toContain("port: Number(process.env.GHOSTAPI_PORT");
    expect(result.content).toContain("protocol: process.env.GHOSTAPI_PROTOCOL");
    expect(result.content).toContain("http://127.0.0.1:8080");
    expect(result.content).toContain("Chaos Mode");
  });
});
