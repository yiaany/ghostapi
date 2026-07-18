import { describe, expect, it } from "vitest";
import { CliError } from "../src/cli/errors.js";
import { parseCliArgs } from "../src/cli/parser.js";

describe("CLI parser", () => {
  it("parses start flags", () => {
    expect(parseCliArgs(["start", "--port", "8443", "--host", "127.0.0.1", "--model", "gemini-flash", "--offline", "--https"])).toEqual({
      name: "start",
      options: { port: 8443, host: "127.0.0.1", model: "gemini-flash", offline: true, https: true }
    });
    expect(parseCliArgs(["start", "--open"])).toEqual({ name: "start", options: { open: true } });
  });

  it("defaults to start", () => {
    expect(parseCliArgs([])).toEqual({ name: "start", options: {} });
  });

  it("parses clear targets", () => {
    expect(parseCliArgs(["clear", "cache"])).toEqual({ name: "clear", target: "cache" });
    expect(parseCliArgs(["clear", "state"])).toEqual({ name: "clear", target: "state" });
    expect(parseCliArgs(["clear", "events"])).toEqual({ name: "clear", target: "events" });
    expect(parseCliArgs(["clear", "all"])).toEqual({ name: "clear", target: "all" });
  });

  it("parses model commands", () => {
    expect(parseCliArgs(["model", "get"])).toEqual({ name: "model-get" });
    expect(parseCliArgs(["model", "set", "gemini-flash"])).toEqual({ name: "model-set", model: "gemini-flash" });
  });

  it("parses provider commands", () => {
    expect(parseCliArgs(["providers", "list"])).toEqual({ name: "providers-list" });
    expect(parseCliArgs(["providers", "inspect", "stripe"])).toEqual({ name: "providers-inspect", provider: "stripe" });
  });

  it("parses doctor and init", () => {
    expect(parseCliArgs(["doctor", "--port", "8081"])).toEqual({ name: "doctor", options: { port: 8081 } });
    expect(parseCliArgs(["init"])).toEqual({ name: "init" });
  });

  it("parses setup and mcp", () => {
    expect(parseCliArgs(["setup"])).toEqual({ name: "setup", options: {} });
    expect(parseCliArgs(["setup", "--write"])).toEqual({ name: "setup", options: { write: true } });
    expect(parseCliArgs(["mcp"])).toEqual({ name: "mcp" });
  });

  it("parses open", () => {
    expect(parseCliArgs(["open", "--port", "8081", "--host", "localhost", "--https"])).toEqual({ name: "open", options: { port: 8081, host: "localhost", https: true } });
  });

  it("parses report", () => {
    expect(parseCliArgs(["report"])).toEqual({ name: "report" });
  });

  it("throws actionable errors for invalid user input", () => {
    expect(() => parseCliArgs(["start", "--port", "nope"])).toThrow(CliError);
    expect(() => parseCliArgs(["clear", "logs"])).toThrow("Unknown clear target");
    expect(() => parseCliArgs(["model", "set"])).toThrow("Missing model name");
    expect(() => parseCliArgs(["providers", "inspect"])).toThrow("Missing provider name");
  });
});
