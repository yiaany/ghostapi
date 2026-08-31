import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSafetyReport } from "../src/report/safetyReport.js";

let tempDir: string | null = null;

describe("safety report", () => {
  afterEach(async () => {
    if (tempDir !== null) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("keeps source findings high while downgrading test fixtures", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ghostapi-safety-"));
    await writeFile(join(tempDir, "package.json"), "{}", "utf8");
    await mkdir(join(tempDir, "src"), { recursive: true });
    await mkdir(join(tempDir, "test"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "client.ts"),
      "const host = 'https://api.stripe.com';",
      "utf8",
    );
    await writeFile(
      join(tempDir, "test", "fixture.ts"),
      "const host = 'https://api.stripe.com'; const key = 'sk_live_abcdefghijklmnop';",
      "utf8",
    );

    const report = await generateSafetyReport(tempDir);

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/client.ts", severity: "high" }),
        expect.objectContaining({ file: "test/fixture.ts", severity: "low" }),
      ]),
    );
  });
});
