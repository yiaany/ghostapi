import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("dashboard assets", () => {
  it("avoids unsafe inline scenario handlers and raw event HTML interpolation", async () => {
    const app = await readFile("src/dashboard/app.js", "utf8");

    expect(app).not.toContain("onclick=\"replayScenario('");
    expect(app).toContain('document.createElement("div")');
    expect(app).toContain('path.textContent = String(ev.path ?? "")');
    expect(app).toContain("async function copyText");
    expect(app).toContain("Generated Vitest Test");
    expect(app).toContain("renderScenarios();");
    expect(app).toContain("Saved ${payload.title}");
    expect(app).toContain('fetch("/api/providers")');
    expect(app).toContain("provider === currentFilter ||");
    expect(app).toMatch(/if \(!res\.ok\)\s+throw new Error/);
    expect(app).toContain('console.warn("Ignored malformed SSE event"');
    expect(app).toContain("els.eventCount.textContent = list.length");
    expect(app).toContain('scenarioButton("Arm"');
    expect(app).not.toContain('scenarioButton("Replay"');
  });

  it("does not load dashboard assets from external origins", async () => {
    const files = await Promise.all([
      readFile("src/dashboard/index.html", "utf8"),
      readFile("src/dashboard/styles.css", "utf8"),
      readFile("src/dashboard/app.js", "utf8"),
    ]);

    for (const content of files) {
      expect(content).not.toMatch(/(?:src|href)=["']https?:\/\//i);
      expect(content).not.toMatch(/url\(\s*["']?https?:\/\//i);
      expect(content).not.toContain("@import url(");
    }
  });
});
