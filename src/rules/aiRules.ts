import { detectSdks, readPackageJson } from "../setup/sdkDetector.js";

export type AiRulesResult = {
  filename: ".cursorrules";
  projectRoot: string;
  detected: string[];
  content: string;
};

export async function generateAiRules(projectRoot = process.cwd()): Promise<AiRulesResult> {
  const packageJson = await readPackageJson(projectRoot);
  const detected = detectSdks(packageJson);
  return {
    filename: ".cursorrules",
    projectRoot,
    detected,
    content: buildCursorRules(detected)
  };
}

function buildCursorRules(detected: string[]): string {
  const lines = [
    "# GhostAPI Agent Rules",
    "",
    "You are working in a project that should use GhostAPI for local API simulations.",
    "Never call paid or production third-party APIs during local tests unless the user explicitly asks.",
    "Route supported SDKs and raw HTTP calls through http://127.0.0.1:8080.",
    "Use GhostAPI MCP tools when available to inspect state, configure deterministic API behavior, read traffic logs, and toggle Chaos Mode.",
    ""
  ];

  if (detected.includes("stripe")) {
    lines.push(
      "## Stripe",
      "",
      "This project depends on `stripe`. Configure the Stripe client to use GhostAPI in local development:",
      "",
      "```ts",
      "import Stripe from \"stripe\";",
      "",
      "export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? \"stripe_test_ghostapi\", {",
      "  host: process.env.GHOSTAPI_HOST ?? \"127.0.0.1\",",
      "  port: Number(process.env.GHOSTAPI_PORT ?? \"8080\"),",
      "  protocol: process.env.GHOSTAPI_PROTOCOL ?? \"http\"",
      "});",
      "```",
      "",
      "Prefer `GHOSTAPI_HOST=127.0.0.1`, `GHOSTAPI_PORT=8080`, and `GHOSTAPI_PROTOCOL=http` in local env files instead of hard-coding production URLs.",
      "When writing tests, assert behavior against GhostAPI responses and avoid using live Stripe credentials.",
      ""
    );
  }

  if (detected.length === 0) {
    lines.push(
      "## No Known SDKs Detected",
      "",
      "No first-class provider SDK was found in `package.json`. For raw HTTP clients, set the API base URL to `http://127.0.0.1:8080` during local development.",
      ""
    );
  }

  lines.push(
    "## Chaos Testing",
    "",
    "When testing retry logic, ask GhostAPI to enable Chaos Mode. Expect occasional provider-shaped `429` and `503` responses or 2-5 second artificial latency.",
    ""
  );

  return lines.join("\n");
}
