import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";

const mode = process.argv[2];

if (mode === "ghostapi") {
  const response = await fetch(`${process.env.GHOSTAPI_BASE_URL}/health`);
  process.exitCode = response.status === 200 ? 0 : 1;
} else if (mode === "fetch-external") {
  process.exitCode = await expectFailure(() => fetch("https://example.com"));
} else if (mode === "https-external") {
  process.exitCode = await expectFailure(() => request(https, "https://example.com"));
} else if (mode === "direct-ip") {
  process.exitCode = await expectFailure(() => request(http, "http://198.51.100.1"));
} else if (mode === "child-fetch") {
  const child = spawn(process.execPath, [process.argv[1], "fetch-external"], { stdio: "inherit" });
  process.exitCode = await waitForExit(child);
} else if (mode === "curl") {
  const child = spawn("curl", ["--connect-timeout", "1", "http://198.51.100.1"], { stdio: "ignore" });
  const exitCode = await waitForExit(child);
  process.exitCode = exitCode === 0 ? 1 : 0;
} else if (mode === "exit") {
  process.exitCode = Number(process.argv[3] ?? "0");
} else if (mode === "wait") {
  await new Promise(() => undefined);
} else if (mode === "large-output") {
  process.stdout.write("x".repeat(16 * 1024));
} else if (mode === "secret-output") {
  process.stdout.write("sk_live_output_should_not_persist");
} else {
  throw new Error(`Unknown egress target mode: ${mode}`);
}

async function expectFailure(operation) {
  try {
    await operation();
    return 1;
  } catch {
    return 0;
  }
}

function request(client, url) {
  return new Promise((resolve, reject) => {
    const request = client.get(url, { timeout: 1_000 }, (response) => {
      response.resume();
      resolve();
    });
    request.once("timeout", () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
