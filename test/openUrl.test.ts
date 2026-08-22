import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openUrl, validateOpenUrl } from "../src/cli/openUrl.js";

describe("openUrl", () => {
  it("uses the Windows URL handler without cmd.exe or a shell", () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawnUrl = vi.fn(() => child as never);
    openUrl("http://127.0.0.1:8080/dashboard?x=%26calc.exe", "win32", spawnUrl as never);

    expect(spawnUrl).toHaveBeenCalledWith("rundll32.exe", ["url.dll,FileProtocolHandler", "http://127.0.0.1:8080/dashboard?x=%26calc.exe"], expect.objectContaining({ shell: false }));
    expect(spawnUrl).not.toHaveBeenCalledWith("cmd", expect.anything(), expect.anything());
  });

  it("rejects invalid hosts, credentials, and non-HTTP schemes", () => {
    expect(() => validateOpenUrl("file:///C:/Windows/System32/calc.exe")).toThrow("HTTP(S)");
    expect(() => validateOpenUrl("http://user:pass@localhost/dashboard")).toThrow("no credentials");
    expect(() => validateOpenUrl("http://bad_host/dashboard")).toThrow("host is invalid");
  });
});
