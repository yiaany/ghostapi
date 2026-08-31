import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const expectedSha =
  process.env.GITHUB_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const spec = `${packageJson.name}@${packageJson.version}`;

for (let attempt = 1; attempt <= 6; attempt += 1) {
  try {
    const metadata = JSON.parse(
      execFileSync("npm", ["view", spec, "version", "gitHead", "--json"], {
        encoding: "utf8",
      }),
    );
    if (metadata.version !== packageJson.version)
      throw new Error(`registry version is ${metadata.version}`);
    if (metadata.gitHead !== expectedSha)
      throw new Error(`registry gitHead is ${metadata.gitHead ?? "missing"}`);
    console.log(`Verified ${spec} at ${expectedSha}.`);
    process.exit(0);
  } catch (error) {
    if (attempt === 6) throw error;
    await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
  }
}
