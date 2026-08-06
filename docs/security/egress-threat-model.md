# Egress Threat Model

Last verified: 2026-08-06.

## Security Claim

GhostAPI 0.1.x is a local API simulator and HTTP proxy-guidance tool. It does **not** currently isolate a process or enforce an egress policy. `ghostapi doctor --egress` must therefore report `NOT ISOLATED` on every platform.

Changing an SDK base URL, setting `HTTP_PROXY`, or instructing an agent to use GhostAPI is useful **accidental safety**. It is not a hostile-code sandbox and is not evidence that production egress was impossible.

No design in this document claims protection from an administrator/root-equivalent actor, a compromised host, or a malicious process with control of the same user account outside a future containment boundary.

## Assets And Security Goals

- Prevent accidental calls to production providers while developers and AI agents test code.
- Make attempted allowed and blocked connections attributable to one `ghostapi run` execution.
- Prevent direct IP, alternate DNS, UDP/QUIC, local-network and subprocess bypasses when a supported enforcement backend is active.
- Fail closed when the requested guarantee cannot be established.
- Avoid persistent, system-wide proxy, DNS, routing, firewall or daemon state.

## Threat Actors

| Actor or path | Proxy guidance | Process/container enforcement target |
| --- | --- | --- |
| Incorrect application code | Usually caught only when it uses the configured local base URL. | Deny all non-explicit network paths. |
| AI agent creates another HTTP client | Bypasses guidance. | Same child process remains constrained. |
| `curl`, shell command, or subprocess | Bypasses guidance. | Descendants must remain in the containment boundary. |
| Direct IP address | Bypasses hostname-based proxy/DNS policy. | No route/socket path unless explicitly allowed. |
| Custom DNS resolver or DoH | Bypasses configured resolver assumptions. | Resolver traffic is denied with all other network traffic. |
| UDP or QUIC | Often bypasses HTTP-only controls. | All socket families and protocols are denied by the boundary. |
| Local-network target | Often omitted from production-focused allowlists. | Deny by default; allow only deliberate loopback transport. |
| Malicious same-user process | Out of scope for guidance. | Cannot be contained by a boundary it does not enter; same-user hostile code is not a guarantee from Node permission flags. |

## Guarantee Levels

### HTTP Proxy Guidance

GhostAPI configures or documents a local HTTP endpoint and can collect only traffic voluntarily sent there. It can reduce accidental provider calls, but cannot prevent a different HTTP library, an IP literal, custom DNS, subprocess, UDP/QUIC, or local-network request.

This is the **only active guarantee** in the current release.

### Process-Level Enforcement

A process launcher creates an OS-supported restricted execution boundary and starts the target only after a local preflight passes. The future boundary must cover children and inherited handles, deny all network by default, and expose GhostAPI through an intentionally configured loopback or private transport.

This is not implemented in GhostAPI 0.1.x.

### Container Or Network-Namespace Enforcement

The target runs in a separate container or network namespace with only loopback, no host networking, no privileged mode, and no mounted container-control socket. This can provide the strongest planned local guarantee, but still does not protect against the container runtime daemon, an administrator, a compromised host, or an explicitly reintroduced host-network path.

This is not implemented in GhostAPI 0.1.x.

### Unsupported Or Degraded

If a native primitive is absent, a required privilege is unavailable, or GhostAPI has no reviewed launcher, the command must not claim isolation. It returns a clear degraded or unsupported result and recommends a reviewed container/VM backend where appropriate.

## Platform Capability Model

### Linux

Linux network namespaces isolate network devices, IP stacks, routing tables, firewall state, sockets, and related networking resources. The Linux manual also documents that the kernel must be configured with `CONFIG_NET_NS`; namespace lifecycle can naturally clean up devices once the last process exits. [Linux network namespaces](https://man7.org/linux/man-pages/man7/network_namespaces.7.html)

Planned backend: an unprivileged parent performs policy/evidence work, then launches the target in a new user and network namespace with loopback only. A preflight must prove namespace creation works on that host; otherwise the command fails closed. The launcher must not bridge a veth to the host network, inherit a connected socket, or mount a control socket into the child.

### Containers

Docker documents `--network none` as a mode that creates only a loopback interface inside the container. [Docker none network driver](https://docs.docker.com/engine/network/drivers/none/)

Planned backend: use an OCI runtime only when a bounded image/mount policy is available. `--network host`, privileged containers, mounted Docker/Podman sockets, and host credentials invalidate the intended boundary. GhostAPI will not start or configure a privileged daemon.

### Windows

Microsoft documents AppContainer as an isolation environment with network access granted only for explicitly allocated Internet, intranet, or server capabilities. [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)

Planned backend: a per-run AppContainer or LPAC launcher with no network capabilities and a dedicated writable directory. GhostAPI does not create profiles or launch AppContainers today, and a normal Win32 child process is not constrained. A future implementation must clean up its profile deterministically without changing global Windows Firewall state.

### macOS

Apple's App Sandbox is entitlement-based and intended for signed application bundles, not a general-purpose wrapper for arbitrary developer shell commands. [App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)

Planned backend: use an explicit container or VM backend before claiming egress enforcement for arbitrary child commands. GhostAPI must not report `isolated` solely because proxy environment variables or a deprecated sandbox wrapper exists.

### Node.js Runtime

Node's Permission Model is activated with `--permission`; a launched Node process without `--allow-net` is denied network access. Node explicitly describes the model as a seat belt for trusted code and says it does not provide security guarantees against malicious code. [Node.js Permissions](https://nodejs.org/api/permissions.html)

GhostAPI reports this as a degraded auxiliary control only. It cannot contain non-Node children, is not the future `ghostapi run` hostile-sandbox boundary, and does not replace OS-level isolation.

## Capability API And CLI Contract

```bash
ghostapi doctor --egress
ghostapi doctor --egress --json
```

The JSON report is offline and deterministic apart from local runtime facts. It contains:

- `schemaVersion` for machine consumers.
- `isolated`, which is currently always `false`.
- `currentGuarantee`, currently `http-proxy-guidance`.
- Platform/runtime facts and one record per possible backend.
- Backend status: `available`, `degraded`, `not-implemented`, or `unsupported`.
- Required privileges/setup and remaining bypasses.
- A `globalStateChanged: false` invariant.

The command does not open a network connection, change proxy settings, add firewall rules, create network namespaces, create an AppContainer profile, or contact a container daemon.

## Minimal Cross-Platform Architecture

1. A platform-neutral policy compiler canonicalizes the allow/deny policy, local GhostAPI transport, command arguments, and run ID.
2. An unprivileged parent creates evidence and validates the selected backend before spawning the target.
3. A small reviewed backend implements `prepare`, `spawn`, `collect`, and `cleanup` for Linux namespaces, Windows AppContainer/LPAC, or an explicit OCI/VM runner.
4. Each backend owns its resources by process or container lifetime. Crash cleanup relies on resource ownership, with bounded reconciliation only for leftovers that can be safely identified by a run-specific marker.
5. A per-run recorder emits attempted connection metadata and a signed/finalized local evidence artifact. It must distinguish a setup failure from a blocked request and an unknown outcome.
6. A backend that cannot prove the requested guarantee returns `unsupported` or `degraded`; it never silently falls back to proxy guidance for a command advertised as isolated.

## Non-Goals For The First `ghostapi run`

- Global firewall, global proxy, global DNS, hosts-file, routing-table, or system service changes.
- Transparent interception of another user's process.
- Protection from root/administrator, the host kernel, or a compromised container runtime.
- Hidden installation of a privileged daemon.
- A claim that Node permissions sandbox hostile code.
