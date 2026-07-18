import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { generateRepoSetup, writeRepoSetup } from "../src/setup/setupGenerator.js";

let tempDir: string | null = null;

describe("repo setup generator", () => {
  afterEach(async () => {
    if (tempDir !== null) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("detects SDKs and generates copy-ready agent configs", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ghostapi-setup-"));
    await writeFile(join(tempDir, "package.json"), JSON.stringify({ dependencies: { stripe: "^18.0.0", openai: "^5.0.0" } }), "utf8");

    const setup = await generateRepoSetup(tempDir);

    expect(setup.detected).toEqual(["stripe", "openai"]);
    expect(setup.commands).toContain("ghostapi doctor");
    expect(setup.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      ".cursorrules",
      "AGENTS.md",
      ".cursor/mcp.json",
      "cline_mcp_settings.json",
      "claude_desktop_config.json",
      ".ghostapi/agent-configs/claude-cli.json",
      ".ghostapi/agent-configs/claude-desktop.json",
      ".ghostapi/agent-configs/aider.md",
      ".ghostapi/agent-configs/codex.json",
      ".ghostapi/agent-configs/opencode-cli.json",
      ".ghostapi/agent-configs/opencode-desktop.json",
      ".ghostapi/agent-configs/gemini-cli.json",
      ".ghostapi/agent-configs/goose.json",
      ".ghostapi/agent-configs/openclaw.json",
      ".ghostapi/agent-configs/hermes-desktop.json",
      ".ghostapi/agent-configs/universal-mcp.json"
    ]));
    expect(setup.files.find((file) => file.path === ".cursor/mcp.json")?.content).toContain('"command": "ghostapi"');
    expect(setup.files.find((file) => file.path === "AGENTS.md")?.content).toContain("ghostapi mcp");
    expect(setup.patches.map((patch) => patch.title)).toEqual(expect.arrayContaining(["Stripe client patch", "OpenAI client patch"]));
  });

  it("writes setup files safely without overwriting existing files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ghostapi-setup-write-"));
    await writeFile(join(tempDir, "package.json"), JSON.stringify({ dependencies: { stripe: "^18.0.0" } }), "utf8");
    await writeFile(join(tempDir, ".cursorrules"), "existing", "utf8");

    const { result } = await writeRepoSetup(tempDir);

    expect(result.skipped).toContain(".cursorrules");
    expect(result.created).toEqual(expect.arrayContaining(["AGENTS.md", ".cursor/mcp.json", "cline_mcp_settings.json", "claude_desktop_config.json", ".ghostapi/agent-configs/universal-mcp.json"]));
    await expect(readFile(join(tempDir, ".cursorrules"), "utf8")).resolves.toBe("existing");
  });
});
