import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readPackageJson, detectSdks, type DetectedSdk } from "./sdkDetector.js";
import { generateAiRules } from "../rules/aiRules.js";

export type SetupFile = {
  path: string;
  description: string;
  content: string;
};

export type SetupPatch = {
  title: string;
  appliesTo: string;
  content: string;
};

export type RepoSetup = {
  projectRoot: string;
  detected: DetectedSdk[];
  commands: string[];
  files: SetupFile[];
  patches: SetupPatch[];
  summary: string;
};

export type SetupWriteResult = {
  created: string[];
  skipped: string[];
};

export async function generateRepoSetup(projectRoot = process.cwd()): Promise<RepoSetup> {
  const packageJson = await readPackageJson(projectRoot);
  const detected = detectSdks(packageJson);
  const rules = await generateAiRules(projectRoot);
  const mcpConfig = buildMcpConfig();
  const opencodeConfig = buildOpenCodeConfig();
  const mcpServers = { mcpServers: { ghostapi: mcpConfig } };
  const autoApprovedMcpServers = { mcpServers: { ghostapi: { ...mcpConfig, disabled: false, autoApprove: ["inspect_state", "get_traffic_logs"] } } };
  const files: SetupFile[] = [
    { path: ".cursorrules", description: "Cursor agent rules for GhostAPI-first local API development.", content: rules.content },
    { path: "AGENTS.md", description: "Universal agent instructions for Aider, Codex-style agents, Gemini CLI, OpenCode, Goose, OpenClaw, and Hermes.", content: buildAgentInstructions(detected) },
    { path: ".cursor/mcp.json", description: "Cursor MCP server config.", content: JSON.stringify(mcpServers, null, 2) },
    { path: "cline_mcp_settings.json", description: "Cline MCP server config snippet.", content: JSON.stringify(autoApprovedMcpServers, null, 2) },
    { path: "claude_desktop_config.json", description: "Claude Desktop MCP server config snippet.", content: JSON.stringify(mcpServers, null, 2) },
    { path: ".ghostapi/agent-configs/universal-mcp.json", description: "Universal stdio MCP block for any MCP-compatible client.", content: JSON.stringify(mcpServers, null, 2) },
    { path: ".ghostapi/agent-configs/claude-cli.json", description: "Claude CLI MCP snippet.", content: JSON.stringify(mcpServers, null, 2) },
    { path: ".ghostapi/agent-configs/claude-desktop.json", description: "Claude Desktop MCP snippet.", content: JSON.stringify(mcpServers, null, 2) },
    { path: ".ghostapi/agent-configs/cline.json", description: "Cline MCP snippet.", content: JSON.stringify(autoApprovedMcpServers, null, 2) },
    { path: ".ghostapi/agent-configs/aider.md", description: "Aider instructions and MCP handoff note.", content: buildClientInstructions("Aider", detected) },
    { path: ".ghostapi/agent-configs/codex.json", description: "Codex MCP snippet.", content: JSON.stringify(mcpServers, null, 2) },
    { path: ".ghostapi/agent-configs/opencode-cli.json", description: "OpenCode CLI MCP snippet.", content: JSON.stringify(mcpServers, null, 2) },
    { path: ".ghostapi/agent-configs/opencode-desktop.json", description: "OpenCode Desktop MCP snippet.", content: JSON.stringify(mcpServers, null, 2) },
    { path: ".opencode/opencode.json", description: "Project-level OpenCode MCP config loaded automatically when OpenCode starts in this repo.", content: JSON.stringify(opencodeConfig, null, 2) },
    { path: ".ghostapi/agent-configs/gemini-cli.json", description: "Gemini CLI MCP snippet.", content: JSON.stringify(mcpServers, null, 2) },
    { path: ".ghostapi/agent-configs/goose.json", description: "Goose MCP snippet.", content: JSON.stringify(mcpServers, null, 2) },
    { path: ".ghostapi/agent-configs/openclaw.json", description: "OpenClaw MCP snippet.", content: JSON.stringify(mcpServers, null, 2) },
    { path: ".ghostapi/agent-configs/hermes-desktop.json", description: "Hermes Desktop MCP snippet.", content: JSON.stringify(mcpServers, null, 2) }
  ];

  return {
    projectRoot,
    detected,
    commands: ["ghostapi init", "ghostapi doctor", "ghostapi start --open", "ghostapi mcp"],
    files,
    patches: buildPatches(detected),
    summary: buildSummary(detected)
  };
}

export async function writeRepoSetup(projectRoot = process.cwd()): Promise<{ setup: RepoSetup; result: SetupWriteResult }> {
  const setup = await generateRepoSetup(projectRoot);
  const result: SetupWriteResult = { created: [], skipped: [] };

  for (const file of setup.files) {
    const target = join(projectRoot, file.path);
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, { encoding: "utf8", flag: "wx" });
      result.created.push(file.path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        result.skipped.push(file.path);
        continue;
      }
      throw error;
    }
  }

  return { setup, result };
}

function buildMcpConfig() {
  return { command: "ghostapi", args: ["mcp"] };
}

function buildOpenCodeConfig() {
  return {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      ghostapi: {
        type: "local",
        command: ["npx", "-y", "@yiaany/ghostapi", "mcp"],
        enabled: true
      }
    }
  };
}

function buildSummary(detected: DetectedSdk[]): string {
  const sdkText = detected.length > 0 ? detected.join(", ") : "no known provider SDKs";
  return `Detected ${sdkText}. Copy the generated files into your repo, run ghostapi start --open, and point local SDK clients at http://127.0.0.1:8080.`;
}

function buildAgentInstructions(detected: DetectedSdk[]): string {
  return buildClientInstructions("any coding agent", detected);
}

function buildClientInstructions(clientName: string, detected: DetectedSdk[]): string {
  const sdkText = detected.length > 0 ? detected.join(", ") : "no known provider SDKs";
  return [
    "# GhostAPI Agent Instructions",
    "",
    `These instructions are for ${clientName} working in this repository.`,
    "",
    "## Local API Runtime",
    "",
    "Use GhostAPI as the local API layer for third-party integrations.",
    "",
    "```bash",
    "ghostapi start --open",
    "ghostapi mcp",
    "```",
    "",
    "Route local SDKs and HTTP clients to `http://127.0.0.1:8080` instead of live providers during development and tests.",
    "",
    "## MCP Server",
    "",
    "If your client supports MCP, add this stdio server:",
    "",
    "```json",
    JSON.stringify({ mcpServers: { ghostapi: buildMcpConfig() } }, null, 2),
    "```",
    "",
    "Use GhostAPI MCP tools to inspect local state, configure deterministic responses, read traffic logs, and toggle Chaos Mode.",
    "",
    "## Detected SDKs",
    "",
    `Detected: ${sdkText}.`,
    "",
    "Never use production API keys or live provider endpoints unless the user explicitly asks."
  ].join("\n");
}

function buildPatches(detected: DetectedSdk[]): SetupPatch[] {
  const patches: SetupPatch[] = [
    {
      title: "Local API base URL env",
      appliesTo: ".env.local",
      content: [
        "GHOSTAPI_BASE_URL=http://127.0.0.1:8080",
        "GHOSTAPI_HOST=127.0.0.1",
        "GHOSTAPI_PORT=8080",
        "GHOSTAPI_PROTOCOL=http",
        "GHOSTAPI_OPENAI_BASE_URL=http://127.0.0.1:8080/v1"
      ].join("\n")
    }
  ];

  if (detected.includes("stripe")) {
    patches.push({
      title: "Stripe client patch",
      appliesTo: "Stripe client initialization",
      content: [
        "import Stripe from \"stripe\";",
        "",
        "export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? \"stripe_test_ghostapi\", {",
        "  host: process.env.GHOSTAPI_HOST ?? \"127.0.0.1\",",
        "  port: Number(process.env.GHOSTAPI_PORT ?? \"8080\"),",
        "  protocol: process.env.GHOSTAPI_PROTOCOL ?? \"http\"",
        "});"
      ].join("\n")
    });
  }

  if (detected.includes("openai")) {
    patches.push({
      title: "OpenAI client patch",
      appliesTo: "OpenAI client initialization",
      content: [
        "import OpenAI from \"openai\";",
        "",
        "export const openai = new OpenAI({",
        "  apiKey: process.env.OPENAI_API_KEY ?? \"sk-ghostapi\",",
        "  baseURL: process.env.GHOSTAPI_OPENAI_BASE_URL ?? \"http://127.0.0.1:8080/v1\"",
        "});"
      ].join("\n")
    });
  }

  return patches;
}
