import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getStateStore } from "../state/stateStore.js";
import { getEventsHistory } from "../server/eventsStore.js";
import { setApiBehavior } from "../behavior/behaviorStore.js";
import { getFaultLabConfig, updateFaultLabConfig } from "../fault/faultLab.js";

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "ghostapi", version: "0.1.0" });

  server.registerTool(
    "inspect_state",
    {
      title: "Inspect GhostAPI State",
      description: "Return the current local object state from .ghostapi/state.json."
    },
    async () => jsonResult(await getStateStore())
  );

  server.registerTool(
    "set_api_behavior",
    {
      title: "Set API Behavior",
      description: "Configure a deterministic local response for a method/path pair.",
      inputSchema: {
        path: z.string().min(1),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
        status: z.number().int().min(100).max(599).default(200),
        body: z.unknown().default({ ok: true }),
        headers: z.record(z.string(), z.string()).optional()
      }
    },
    async (args) => jsonResult({ behavior: await setApiBehavior(args) })
  );

  server.registerTool(
    "get_traffic_logs",
    {
      title: "Get Traffic Logs",
      description: "Return the latest 50 captured HTTP requests from the in-memory dashboard buffer."
    },
    async () => jsonResult({ events: getEventsHistory().slice(-50).reverse() })
  );

  server.registerTool(
    "toggle_chaos_mode",
    {
      title: "Toggle Fault Lab",
      description: "Enable or disable local latency/errors for resilience testing.",
      inputSchema: {
        enabled: z.boolean(),
        latencyMs: z.number().int().min(0).max(10_000).optional(),
        errorRate: z.number().int().min(0).max(100).optional(),
        statusCode: z.union([z.literal(429), z.literal(500), z.literal(502), z.literal(503)]).optional(),
        retryAfterSeconds: z.number().int().min(0).max(120).optional()
      }
    },
    async (args) => jsonResult({ faultLab: updateFaultLabConfig({ ...getFaultLabConfig(), ...args }) })
  );

  await server.connect(new StdioServerTransport());
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
