import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "ghostapi package smoke "));
const packDir = join(tempRoot, "packed artifact");
const installDir = join(tempRoot, "fresh app with spaces");
const dataDir = join(tempRoot, "ghostapi data with spaces");

try {
  const packed = await run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: root });
  const packOutput = JSON.parse(packed.stdout);
  const tarballName = Array.isArray(packOutput) && packOutput[0]?.filename ? packOutput[0].filename : null;
  const tarball = tarballName === null ? await findTarball(packDir) : isAbsolute(tarballName) ? tarballName : join(packDir, tarballName);
  const files = Array.isArray(packOutput) && Array.isArray(packOutput[0]?.files) ? packOutput[0].files.map((file) => String(file.path)) : [];
  assertPackageList(files);

  await run("npm", ["init", "-y"], { cwd: installDir, createCwd: true });
  await writeFile(join(installDir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('ghostapi smoke test')\"" } }, null, 2), "utf8");
  await run("npm", ["install", "--ignore-scripts", tarball], { cwd: installDir });

  const cli = join(installDir, "node_modules", "@yiaany", "ghostapi", "dist", "cli", "index.js");
  await run(process.execPath, [cli, "init"], { cwd: installDir, env: { GHOSTAPI_DATA_DIR: dataDir } });
  const doctor = await run(process.execPath, [cli, "doctor", "--port", "65529", "--json"], { cwd: installDir, env: { GHOSTAPI_DATA_DIR: dataDir } });
  const doctorReport = JSON.parse(doctor.stdout);
  if (doctorReport.schemaVersion !== 1 || !Array.isArray(doctorReport.checks)) throw new Error("doctor --json returned an invalid report");
  await run(process.execPath, [cli, "providers", "inspect", "stripe"], { cwd: installDir, env: { GHOSTAPI_DATA_DIR: dataDir } });

  await assertNoLiveSecrets(join(installDir, "node_modules", "@yiaany", "ghostapi"));

  console.log(`PASS package smoke installed ${tarball} into ${installDir}`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function assertNoLiveSecrets(directory) {
  const { readdir, stat } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertNoLiveSecrets(target);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(target);
    if (info.size > 1024 * 1024) continue;
    const text = await readFile(target, "utf8").catch(() => "");
    if (/sk_live_[A-Za-z0-9]{8,}|rk_live_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}/.test(text)) throw new Error(`Installed package contains a live-secret-shaped value: ${target}`);
  }
}

async function findTarball(directory) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory);
  const tarball = entries.find((entry) => entry.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack did not create a tarball");
  return join(directory, tarball);
}

function assertPackageList(files) {
  const forbidden = ["MASTER_PROMPT.md", "PROJECT_CONTEXT.md", "SESSION_LOG.md", "sessions/", "hosted/", ".ghostapi/"];
  for (const file of files) {
    if (forbidden.some((prefix) => file === prefix.replace(/\/$/, "") || file.startsWith(prefix))) {
      throw new Error(`Forbidden package artifact included: ${file}`);
    }
  }
}

function run(command, args, options = {}) {
  return new Promise(async (resolve, reject) => {
    if (options.createCwd) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(options.cwd, { recursive: true });
    }
    if (command === "npm" && args[0] === "pack") {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(args[args.length - 1], { recursive: true });
    }
    const invocation = command === "npm" && process.env.npm_execpath
      ? { executable: process.execPath, args: [process.env.npm_execpath, ...args] }
      : { executable: process.platform === "win32" && command === "npm" ? "npm.cmd" : command, args };
    const child = spawn(invocation.executable, invocation.args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${invocation.executable} ${invocation.args.join(" ")} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}
