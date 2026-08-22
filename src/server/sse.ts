import type { Response } from "express";
import type { ProxyEvent } from "./eventsStore.js";
import { randomUUID } from "node:crypto";

type SseClient = {
  id: string;
  response: Response;
};

const clients = new Set<SseClient>();
export const MAX_SSE_CLIENTS = 100;

export function addSseClient(response: Response): boolean {
  if (clients.size >= MAX_SSE_CLIENTS) return false;
  const client: SseClient = {
    id: randomUUID(),
    response
  };

  clients.add(client);

  requestAnimationFrameMock(() => {
    if (!client.response.writableEnded && !client.response.destroyed) {
      if (!client.response.write(`data: ${JSON.stringify({ type: "connected", id: client.id })}\n\n`)) removeSlowClient(client);
    }
  });

  response.on("close", () => {
    clients.delete(client);
  });
  return true;
}

export function broadcastEvent(event: ProxyEvent): void {
  const payload = `data: ${JSON.stringify({ type: "proxy_event", event })}\n\n`;
  for (const client of clients) {
    if (!client.response.writableEnded && !client.response.destroyed) {
      if (!client.response.write(payload)) removeSlowClient(client);
    }
  }
}

export function getSseClientCount(): number {
  return clients.size;
}

// Ensure non-blocking delayed execution
function requestAnimationFrameMock(fn: () => void) {
  setTimeout(fn, 0);
}

function removeSlowClient(client: SseClient): void {
  clients.delete(client);
  if (!client.response.writableEnded && !client.response.destroyed) client.response.end();
}
