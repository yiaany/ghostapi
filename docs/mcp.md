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
      "args": ["-y", "@yiaany/ghostapi", "mcp"]
    }
  }
}
```

## Generate Client Snippets

```bash
npx @yiaany/ghostapi setup --write
```

This writes copy-ready local snippets under `.ghostapi/agent-configs/` and project instructions for supported agent clients.

## Tools

| Tool | Purpose |
| --- | --- |
| `inspect_state` | Read local API objects from `.ghostapi/state.json`. |
| `get_traffic_logs` | Inspect recent captured API traffic. |
| `set_api_behavior` | Force a deterministic local response for `method + path`. |
| `toggle_chaos_mode` | Enable or disable local latency and error injection. |

## Agent Prompt

```text
Use the GhostAPI MCP server.

Keep all third-party API calls local on http://127.0.0.1:8080.
Do not call real providers.

Use GhostAPI MCP tools to inspect state, read traffic logs, configure deterministic responses, and test failure scenarios.
```
