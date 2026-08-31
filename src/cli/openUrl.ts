import { spawn, type ChildProcess } from "node:child_process";
import { isIP } from "node:net";

type SpawnUrl = (
  command: string,
  args: readonly string[],
  options: {
    detached: boolean;
    stdio: "ignore";
    shell: false;
    windowsHide: boolean;
  },
) => ChildProcess;

export function openUrl(
  value: string,
  platform = process.platform,
  spawnUrl: SpawnUrl = spawn,
): void {
  const url = validateOpenUrl(value);
  const command =
    platform === "win32"
      ? "rundll32.exe"
      : platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawnUrl(command, args, {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  child.unref();
}

export function validateOpenUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Dashboard URL is invalid.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname.length === 0 ||
    parsed.hostname.length > 253 ||
    /[\u0000-\u0020\\]/.test(parsed.hostname)
  ) {
    throw new Error(
      "Dashboard URL must use HTTP(S) with a valid host and no credentials.",
    );
  }
  if (!isValidHost(parsed.hostname))
    throw new Error("Dashboard URL host is invalid.");
  return parsed.toString();
}

function isValidHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || isIP(host) !== 0) return true;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
    host,
  );
}
