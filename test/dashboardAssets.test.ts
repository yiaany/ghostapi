import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("dashboard assets", () => {
  it("avoids unsafe inline scenario handlers and raw event HTML interpolation", async () => {
    const app = await readFile("src/dashboard/app.js", "utf8");

    expect(app).not.toContain("onclick=\"replayScenario('");
    expect(app).toContain("document.createElement('div')");
    expect(app).toContain("path.textContent = String(ev.path ?? '')");
    expect(app).toContain("async function copyText");
  });
});
