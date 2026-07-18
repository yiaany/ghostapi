import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type DetectedSdk = "stripe" | "twilio" | "resend" | "openai" | "github" | "discord";

export type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const SDK_PACKAGES: Record<string, DetectedSdk> = {
  stripe: "stripe",
  twilio: "twilio",
  resend: "resend",
  openai: "openai",
  "@octokit/rest": "github",
  "discord.js": "discord"
};

export async function readPackageJson(projectRoot = process.cwd()): Promise<PackageJson> {
  const raw = await readFile(join(projectRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as PackageJson;
}

export function detectSdks(packageJson: PackageJson): DetectedSdk[] {
  const names = new Set<string>();
  for (const group of [packageJson.dependencies, packageJson.devDependencies, packageJson.peerDependencies, packageJson.optionalDependencies]) {
    for (const name of Object.keys(group ?? {})) names.add(name);
  }

  const detected: DetectedSdk[] = [];
  for (const [packageName, sdk] of Object.entries(SDK_PACKAGES)) {
    if (names.has(packageName)) detected.push(sdk);
  }
  return detected;
}
