import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("landing page", () => {
  it("uses the published package and repository identity", async () => {
    const app = await readFile("src/landing/src/App.tsx", "utf8");

    expect(app).toContain("https://github.com/yiaany/ghostapi");
    expect(app).toContain("npx @yiaany/ghostapi start --open");
    expect(app).toContain("npm install -g @yiaany/ghostapi");
    expect(app).not.toContain("https://github.com/ghostapi/ghostapi");
    expect(app).not.toMatch(/npx ghostapi\b/);
  });

  it("ships finished product copy without editorial placeholders", async () => {
    const app = await readFile("src/landing/src/App.tsx", "utf8");

    expect(app).toContain("Deterministic Failure Testing");
    expect(app).toContain("a deterministic failure scenario is armed");
    expect(app).not.toContain("Proof / Screenshot / GIF");
    expect(app).not.toContain("The homepage should");
    expect(app).not.toContain("Everything on the homepage");
  });
});
