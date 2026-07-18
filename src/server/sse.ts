import type { Response } from "express";
import type { ProxyEvent } from "./eventsStore.js";

type SseClient = {
  id: string;
  response: Response;
};

const clients = new Set<SseClient>();

export function addSseClient(response: Response): void {
  const client: SseClient = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    response
  };

  clients.add(client);

  requestAnimationFrameMock(() => {
    if (!client.response.writableEnded && !client.response.destroyed) {
      client.response.write(`data: ${JSON.stringify({ type: "connected", id: client.id })}\n\n`);
    }
  });

  response.on("close", () => {
    clients.delete(client);
  });
}

export function broadcastEvent(event: ProxyEvent): void {
  const payload = `data: ${JSON.stringify({ type: "proxy_event", event })}\n\n`;
  for (const client of clients) {
    if (!client.response.writableEnded && !client.response.destroyed) {
      client.response.write(payload);
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