export type EgressGuaranteeLevel =
  | "unsupported"
  | "http-proxy-guidance"
  | "process-level-enforcement"
  | "container-network-namespace-enforcement";

export type EgressCapabilityStatus = "available" | "degraded" | "not-implemented" | "unsupported";

export type EgressCapability = {
  id: string;
  title: string;
  status: EgressCapabilityStatus;
  guarantee: EgressGuaranteeLevel;
  detail: string;
  requiredPrivileges: string[];
  remainingBypasses: string[];
};

export type EgressRuntimeInfo = {
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
};

export type EgressCapabilityReport = {
  schemaVersion: 1;
  runtime: EgressRuntimeInfo;
  isolated: false;
  currentGuarantee: "http-proxy-guidance";
  summary: string;
  capabilities: EgressCapability[];
  globalStateChanged: false;
  remainingBypasses: string[];
  nextArchitecture: string[];
};

export type EgressRuntimeInput = Partial<EgressRuntimeInfo> & {
  nodeNetworkPermission?: boolean;
};

const PROXY_BYPASSES = [
  "A new HTTP client, direct IP address, custom DNS resolver, UDP, QUIC, local-network target, or subprocess can ignore proxy configuration.",
  "A malicious process running as the same user can create its own network path."
];

const HOSTILE_BYPASSES = [
  "An administrator/root-equivalent actor and a compromised host are outside this threat model.",
  "A separate process running outside the launched containment boundary remains able to use the host network."
];

export function detectEgressCapabilities(input: EgressRuntimeInput = {}): EgressCapabilityReport {
  const runtime: EgressRuntimeInfo = {
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    nodeVersion: input.nodeVersion ?? process.versions.node
  };
  const capabilities = [
    createProxyGuidanceCapability(),
    createNodePermissionCapability(input.nodeNetworkPermission ?? process.allowedNodeEnvironmentFlags.has("--allow-net")),
    ...createPlatformCapabilities(runtime.platform)
  ];

  return {
    schemaVersion: 1,
    runtime,
    isolated: false,
    currentGuarantee: "http-proxy-guidance",
    summary: "GhostAPI currently provides HTTP proxy guidance only. No process is isolated by this version of GhostAPI.",
    capabilities,
    globalStateChanged: false,
    remainingBypasses: [...PROXY_BYPASSES, ...HOSTILE_BYPASSES],
    nextArchitecture: architectureFor(runtime.platform)
  };
}

export function formatEgressCapabilityReport(report: EgressCapabilityReport): string {
  const lines = [
    "GhostAPI egress diagnosis",
    `Runtime: ${report.runtime.platform}/${report.runtime.arch}, Node.js ${report.runtime.nodeVersion}`,
    "Status: NOT ISOLATED",
    "Current guarantee: HTTP proxy guidance only",
    "",
    "Capabilities:"
  ];

  for (const capability of report.capabilities) {
    lines.push(`  ${capability.status.toUpperCase().padEnd(15)} ${capability.title}: ${capability.detail}`);
    if (capability.requiredPrivileges.length > 0) lines.push(`                  Privileges/setup: ${capability.requiredPrivileges.join("; ")}`);
    if (capability.remainingBypasses.length > 0) lines.push(`                  Bypasses: ${capability.remainingBypasses.join(" ")}`);
  }

  lines.push("", "Remaining bypasses:");
  for (const bypass of report.remainingBypasses) lines.push(`  - ${bypass}`);
  lines.push("", "Next architecture:");
  for (const step of report.nextArchitecture) lines.push(`  - ${step}`);
  lines.push("", "No system-wide proxy or firewall rules were inspected or changed.");

  return lines.join("\n");
}

function createProxyGuidanceCapability(): EgressCapability {
  return {
    id: "http-proxy-guidance",
    title: "HTTP proxy guidance",
    status: "available",
    guarantee: "http-proxy-guidance",
    detail: "GhostAPI can guide supported HTTP clients to a local endpoint, but does not intercept or block other traffic.",
    requiredPrivileges: [],
    remainingBypasses: PROXY_BYPASSES
  };
}

function createNodePermissionCapability(supportsNetworkPermission: boolean): EgressCapability {
  return {
    id: "node-permission-model",
    title: "Node.js Permission Model",
    status: supportsNetworkPermission ? "degraded" : "unsupported",
    guarantee: "http-proxy-guidance",
    detail: supportsNetworkPermission
      ? "Recent Node.js releases can deny network access to a Node process, but the model is a seat belt for trusted code, not hostile-code sandboxing."
      : "This Node.js version does not provide a supported network-deny control suitable for GhostAPI egress enforcement.",
    requiredPrivileges: [],
    remainingBypasses: supportsNetworkPermission
      ? ["It applies only to the launched Node process and is not a defense against malicious code or other processes."]
      : ["Any Node program, child process, or native tool can still create network connections."]
  };
}

function createPlatformCapabilities(platform: NodeJS.Platform): EgressCapability[] {
  switch (platform) {
    case "linux":
      return [
        {
          id: "linux-network-namespace",
          title: "Linux network namespace",
          status: "not-implemented",
          guarantee: "process-level-enforcement",
          detail: "Linux network namespaces can isolate network devices, routing tables, protocol stacks, ports, DNS paths, and netfilter state; GhostAPI does not launch one yet.",
          requiredPrivileges: ["A preflight must prove that the host permits creating the required user and network namespaces, or provide the required capabilities."],
          remainingBypasses: ["A future launcher must close inherited sockets and keep the target process out of the host network namespace.", ...HOSTILE_BYPASSES]
        },
        createContainerCapability("An OCI runtime configured with a no-network mode")
      ];
    case "darwin":
      return [
        {
          id: "macos-app-sandbox",
          title: "macOS App Sandbox",
          status: "degraded",
          guarantee: "unsupported",
          detail: "App Sandbox network access is entitlement-based for a signed app and is not a generic GhostAPI subprocess launcher.",
          requiredPrivileges: ["A signed sandboxed application and an entitlement configuration designed for the launched helper."],
          remainingBypasses: ["An arbitrary command launched outside that app sandbox is not constrained.", ...HOSTILE_BYPASSES]
        },
        createContainerCapability("A separately configured Linux-container or VM runtime")
      ];
    case "win32":
      return [
        {
          id: "windows-appcontainer",
          title: "Windows AppContainer",
          status: "not-implemented",
          guarantee: "process-level-enforcement",
          detail: "AppContainer can deny network capability to a launched process, but GhostAPI does not create profiles or launch AppContainers yet.",
          requiredPrivileges: ["An AppContainer/LPAC launcher, a minimal capability profile, and a writable sandbox directory."],
          remainingBypasses: ["A normal Win32 child process is not in an AppContainer.", ...HOSTILE_BYPASSES]
        },
        createContainerCapability("A separately configured Windows or Linux container/VM runtime")
      ];
    default:
      return [
        {
          id: "native-egress-isolation",
          title: "Native egress isolation",
          status: "unsupported",
          guarantee: "unsupported",
          detail: `GhostAPI has no supported native egress-isolation backend for ${platform}.`,
          requiredPrivileges: [],
          remainingBypasses: PROXY_BYPASSES
        },
        createContainerCapability("A separately configured OCI runtime")
      ];
  }
}

function createContainerCapability(requirement: string): EgressCapability {
  return {
    id: "container-network-namespace",
    title: "Container or network-namespace enforcement",
    status: "not-implemented",
    guarantee: "container-network-namespace-enforcement",
    detail: "A no-network container can provide the strongest planned local guarantee, but GhostAPI does not manage containers in this release.",
    requiredPrivileges: [requirement, "An image and mount policy that excludes host network-control sockets and credentials."],
    remainingBypasses: ["Mounted Docker/Podman sockets, host networking, privileged mode, or inherited credentials would break the boundary.", ...HOSTILE_BYPASSES]
  };
}

function architectureFor(platform: NodeJS.Platform): string[] {
  const nativeStep = platform === "linux"
    ? "Implement a Linux launcher that creates a fresh user and network namespace, keeps only loopback, validates setup before spawning, and tears down by process lifetime."
    : platform === "win32"
      ? "Implement a Windows AppContainer/LPAC launcher with no network capabilities, a per-run profile, and deterministic profile cleanup."
      : platform === "darwin"
        ? "Use an explicit container or VM backend first; do not claim arbitrary-child App Sandbox enforcement."
        : "Use an explicit container or VM backend; keep this platform unsupported until a reviewed backend exists.";

  return [
    "Keep policy parsing and evidence collection in an unprivileged GhostAPI parent process.",
    nativeStep,
    "Add an OCI no-network backend that exposes GhostAPI only through a deliberate local transport, never host networking.",
    "Use child-owned namespaces, profiles, and containers so crash cleanup is automatic; do not modify global proxy or firewall state."
  ];
}
