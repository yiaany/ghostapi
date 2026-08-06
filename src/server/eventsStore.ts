import { appendFile, chmod, rename, rm, stat } from "node:fs/promises";
import { getDataPaths } from "../config/dataPaths.js";
import { sanitizeSecrets } from "../security/secrets.js";
import { ensurePrivateDirectory, withFileLock } from "../storage/fileStore.js";

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

export const MAX_EVENTS = 200;
export const MAX_EVENT_LOG_BYTES = 5 * 1024 * 1024;
export const EVENT_LOG_ARCHIVES = 2;
export const MAX_EVENT_BYTES = 256 * 1024;

const eventsBuffer: ProxyEvent[] = [];
const pendingWrites = new Set<Promise<void>>();

export async function addEvent(event: ProxyEvent): Promise<ProxyEvent> {
  const boundedEvent = boundEvent(sanitizeSecrets(event) as ProxyEvent);
  eventsBuffer.push(boundedEvent);

  if (eventsBuffer.length > MAX_EVENTS) eventsBuffer.shift();

  const eventsPath = getDataPaths().events;
  const write = (async () => {
    await withFileLock(eventsPath, async () => {
      const serialized = `${JSON.stringify(boundedEvent)}\n`;
      await rotateIfNeeded(eventsPath, Buffer.byteLength(serialized));
      await ensurePrivateDirectory(getDataPaths().root);
      await appendFile(eventsPath, serialized, { encoding: "utf8", mode: 0o600 });
      if (process.platform !== "win32") await chmod(eventsPath, 0o600);
    });
  })();
  pendingWrites.add(write);
  try {
    await write;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`GhostAPI event persistence failed: ${message}`);
  } finally {
    pendingWrites.delete(write);
  }
  return boundedEvent;
}

export function getEventsHistory(): ProxyEvent[] {
  return structuredClone(eventsBuffer);
}

export function clearEventsHistoryForTests(): void {
  eventsBuffer.length = 0;
}

export async function drainEventWrites(): Promise<void> {
  await Promise.allSettled([...pendingWrites]);
}

export async function clearEvents(): Promise<void> {
  await drainEventWrites();
  eventsBuffer.length = 0;
  const eventsPath = getDataPaths().events;
  await withFileLock(eventsPath, async () => {
    await Promise.all(Array.from({ length: EVENT_LOG_ARCHIVES + 1 }, (_, index) => rm(index === 0 ? eventsPath : `${eventsPath}.${index}`, { force: true })));
  });
}

async function rotateIfNeeded(eventsPath: string, incomingBytes: number): Promise<void> {
  let activeBytes = 0;
  try {
    activeBytes = (await stat(eventsPath)).size;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  if (activeBytes + incomingBytes <= MAX_EVENT_LOG_BYTES) return;

  await rm(`${eventsPath}.${EVENT_LOG_ARCHIVES}`, { force: true });
  for (let index = EVENT_LOG_ARCHIVES - 1; index >= 1; index -= 1) {
    try {
      await rename(`${eventsPath}.${index}`, `${eventsPath}.${index + 1}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  try {
    await rename(eventsPath, `${eventsPath}.1`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function boundEvent(event: ProxyEvent): ProxyEvent {
  if (Buffer.byteLength(JSON.stringify(event)) <= MAX_EVENT_BYTES) return event;
  return {
    ...event,
    request: "[Event details truncated: request exceeded persisted event limit]",
    response: "[Event details truncated: response exceeded persisted event limit]"
  };
}
