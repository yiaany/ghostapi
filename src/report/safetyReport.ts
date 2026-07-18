import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { detectSdks, readPackageJson, type DetectedSdk } from "../setup/sdkDetector.js";

export type SafetyFinding = {
  severity: "high" | "medium" | "low";
  message: string;
  file?: string;
};

export type SafetyReport = {
  projectRoot: string;
  detected: DetectedSdk[];
  findings: SafetyFinding[];
  recommendations: string[];
};

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".ghostapi", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".env", ".json"]);

export async function generateSafetyReport(projectRoot = process.cwd()): Promise<SafetyReport> {
  const packageJson = await readPackageJson(projectRoot);
  const detected = detectSdks(packageJson);
  const findings: SafetyFinding[] = [];

  const files = await collectFiles(projectRoot, projectRoot, 250);
  for (const file of files) {
    const content = await readFile(join(projectRoot, file), "utf8");
    if (/api\.stripe\.com|api\.openai\.com|api\.twilio\.com/i.test(content)) {
      findings.push({ severity: "high", message: "Production provider host appears in source.", file });
    }
    if (/sk_live_[A-Za-z0-9]+/.test(content)) {
      findings.push({ severity: "high", message: "Live-looking Stripe key appears in source.", file });
    }
    if (/STRIPE_SECRET_KEY|OPENAI_API_KEY|TWILIO_AUTH_TOKEN/.test(content) && !/GHOSTAPI_|host:|baseURL/.test(content)) {
      findings.push({ severity: "medium", message: "Provider secret is referenced without an obvious GhostAPI local override nearby.", file });
    }
  }

  return {
    projectRoot,
    detected,
    findings,
    recommendations: buildRecommendations(detected, findings)
  };
}

async function collectFiles(root: string, dir: string, limit: number, acc: string[] = []): Promise<string[]> {
  if (acc.length >= limit) return acc;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (acc.length >= limit) break;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectFiles(root, fullPath, limit, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    const ext = dot >= 0 ? entry.name.slice(dot) : entry.name;
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    const info = await stat(fullPath);
    if (info.size > 300_000) continue;
    acc.push(relative(root, fullPath).replace(/\\/g, "/"));
  }
  return acc;
}

function buildRecommendations(detected: DetectedSdk[], findings: SafetyFinding[]): string[] {
  const recommendations = ["Run ghostapi setup --write to generate agent rules and MCP snippets.", "Use ghostapi start --open during local integration work."];
  if (detected.includes("stripe")) recommendations.push("Configure Stripe with host: '127.0.0.1', port: 8080, and protocol: 'http' for local GhostAPI calls.");
  if (detected.includes("openai")) recommendations.push("Configure OpenAI with baseURL: process.env.GHOSTAPI_OPENAI_BASE_URL ?? 'http://127.0.0.1:8080/v1'.");
  if (findings.some((finding) => finding.severity === "high")) recommendations.push("Remove live-looking keys and production provider hosts before committing.");
  return recommendations;
}
