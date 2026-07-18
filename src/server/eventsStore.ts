import { appendFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export type EventSource = "state" | "cache" | "ai" | "error" | "fallback" | "stream" | "fault" | "behavior";

export type ProxyEvent = {
  id: string;
  timestamp: string;
  provider: string;
  method: string;
  path: string;
  statusCode: number;
  source: EventSource;
  durationMs: number;
  request: unknown;
  response: unknown;
};

const EVENTS_FILE_PATH = join(".ghostapi", "events.jsonl");
const MAX_EVENTS = 200;

const eventsBuffer: ProxyEvent[] = [];

export async function addEvent(event: ProxyEvent): Promise<void> {
  eventsBuffer.push(event);
  
  if (eventsBuffer.length > MAX_EVENTS) {
    eventsBuffer.shift();
  }

  try {
    await mkdir(dirname(EVENTS_FILE_PATH), { recursive: true });
    const serialized = JSON.stringify(event) + "\n";
    await appendFile(EVENTS_FILE_PATH, serialized, "utf8");
  } catch {
    // Silently ignore log write failures to strictly preserve proxy operational stability
  }
}

export function getEventsHistory(): ProxyEvent[] {
  return [...eventsBuffer];
}

export function clearEventsHistoryForTests(): void {
  eventsBuffer.length = 0;
}

export async function clearEvents(): Promise<void> {
  eventsBuffer.length = 0;
  await mkdir(dirname(EVENTS_FILE_PATH), { recursive: true });
  await rm(EVENTS_FILE_PATH, { force: true });
}
