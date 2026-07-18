import { generateRepoSetup } from "../setup/setupGenerator.js";

export type AgentPrompt = {
  title: string;
  content: string;
};

export async function generateAgentPrompt(projectRoot = process.cwd()): Promise<AgentPrompt> {
  const setup = await generateRepoSetup(projectRoot);
  const detected = setup.detected.length > 0 ? setup.detected.join(", ") : "no known SDKs detected";
  return {
    title: "GhostAPI Agent Prompt",
    content: [
      "Use GhostAPI as the local API layer for this repository.",
      "",
      "Rules:",
      "- Do not call production third-party APIs unless the user explicitly asks.",
      "- Route local SDKs and HTTP clients to http://127.0.0.1:8080.",
      "- Use GhostAPI MCP tools when available: inspect_state, set_api_behavior, get_traffic_logs, toggle_chaos_mode.",
      "- Before assuming remote state, inspect GhostAPI state and traffic logs.",
      "- Use scenario replay for payment, email, GitHub, and failure-path tests.",
      "- Use Chaos Mode to verify retry, timeout, and degraded-provider handling.",
      "- Never expose real API keys in logs, screenshots, generated tests, or committed files.",
      "",
      `Detected SDKs: ${detected}.`,
      "",
      "Useful commands:",
      "```bash",
      "ghostapi start --open",
      "ghostapi mcp",
      "ghostapi setup --write",
      "```"
    ].join("\n")
  };
}
