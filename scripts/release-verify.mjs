import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const tag = process.argv[2];
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
const changelog = await readFile("CHANGELOG.md", "utf8");
const expectedTag = `v${packageJson.version}`;

if (tag !== expectedTag) {
  throw new Error(
    `Release tag ${tag ?? "<missing>"} must equal ${expectedTag}.`,
  );
}
if (
  packageLock.version !== packageJson.version ||
  packageLock.packages?.[""]?.version !== packageJson.version
) {
  throw new Error("package.json and package-lock.json versions must match.");
}
if (!changelog.includes(`## ${packageJson.version} -`)) {
  throw new Error(
    `CHANGELOG.md is missing a dated ${packageJson.version} entry.`,
  );
}

const tagType = execFileSync("git", ["cat-file", "-t", `refs/tags/${tag}`], {
  encoding: "utf8",
}).trim();
if (tagType !== "tag") throw new Error(`${tag} must be an annotated tag.`);
execFileSync("git", ["verify-tag", tag], { stdio: "inherit" });

console.log(`Release metadata verified for ${tag}.`);
