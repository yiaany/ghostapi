# GhostAPI MCP Setup

GhostAPI ships with a local stdio MCP server so coding agents can inspect and control the local API world.

## Start MCP

```bash
npx @yiaany/ghostapi mcp
```

## Universal Config

```json
{
  "mcpServers": {
    "ghostapi": {
      "command": "npx",
      "args": ["-y", "@yiaany/ghostapi@0.2.1", "mcp"]
    }
  }
}
```

## Generate Client Snippets

```bash
npx @yiaany/ghostapi setup --write
```

This writes copy-ready local snippets under `.ghostapi/agent-configs/` and project instructions for supported agent clients.

Pin the package version in persistent MCP configuration or use a reviewed local installation. An unpinned `npx -y` command may execute a newer package version without a repository change.

## Tools

| Tool                | Purpose                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `inspect_state`     | Read sanitized local API objects from the configured GhostAPI data directory. |
| `get_traffic_logs`  | Inspect recent captured API traffic.                                          |
| `set_api_behavior`  | Force a deterministic local response for `method + path`.                     |
| `toggle_chaos_mode` | Enable or disable local latency and error injection.                          |

The HTTP server and MCP process must use the same `GHOSTAPI_DATA_DIR` to share state, behaviors, and persisted Fault Lab configuration. Updates use local inter-process locking; this is not distributed coordination for network filesystems.

Connect only trusted local MCP clients. MCP tools can read retained traffic and state and can change simulation behavior. MCP is not an authentication boundary and does not force other processes to route traffic through GhostAPI.

## Agent Prompt

```text
Use the GhostAPI MCP server.

Explicitly configure supported clients to use http://127.0.0.1:8080.
Do not make live provider calls from this generated workflow.

Use GhostAPI MCP tools to inspect state, read traffic logs, configure deterministic responses, and test failure scenarios.
```

Only a successful Linux `ghostapi run` preflight provides process-level egress enforcement. Base-URL configuration and agent instructions are guidance, not containment.
