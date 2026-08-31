import { describe, expect, it } from "vitest";
import {
  detectEgressCapabilities,
  formatEgressCapabilityReport,
} from "../src/egress/capabilities.js";

describe("egress capability detection", () => {
  it("reports Linux namespace enforcement as degraded instead of isolated until preflight", () => {
    const report = detectEgressCapabilities({
      platform: "linux",
      arch: "x64",
      nodeVersion: "26.4.0",
      nodeNetworkPermission: true,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      isolated: false,
      currentGuarantee: "http-proxy-guidance",
    });
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        id: "linux-network-namespace",
        status: "degraded",
        guarantee: "process-level-enforcement",
      }),
    );
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        id: "node-permission-model",
        status: "degraded",
        guarantee: "process-level-enforcement",
        requiredPrivileges: [
          "Launch the target with --permission and do not grant --allow-net.",
        ],
      }),
    );
  });

  it("maps Windows to a non-green AppContainer backend", () => {
    const report = detectEgressCapabilities({
      platform: "win32",
      arch: "x64",
      nodeVersion: "20.20.2",
      nodeNetworkPermission: false,
    });

    expect(report.isolated).toBe(false);
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        id: "windows-appcontainer",
        status: "not-implemented",
        guarantee: "process-level-enforcement",
      }),
    );
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        id: "node-permission-model",
        status: "unsupported",
      }),
    );
  });

  it("keeps unsupported platforms out of an isolated status", () => {
    const report = detectEgressCapabilities({
      platform: "freebsd",
      arch: "x64",
      nodeVersion: "26.4.0",
      nodeNetworkPermission: true,
    });

    expect(report.isolated).toBe(false);
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        id: "native-egress-isolation",
        status: "unsupported",
        guarantee: "unsupported",
      }),
    );
  });

  it("keeps the JSON and human output contracts explicit about no isolation", () => {
    const report = detectEgressCapabilities({
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "26.4.0",
      nodeNetworkPermission: true,
    });
    const json = JSON.stringify(report, null, 2);
    const human = formatEgressCapabilityReport(report);

    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: 1,
      isolated: false,
      currentGuarantee: "http-proxy-guidance",
    });
    expect(human).toContain("Status: NO PROCESS LAUNCHED");
    expect(human).toContain(
      "No system-wide proxy or firewall rules were inspected or changed.",
    );
  });
});
