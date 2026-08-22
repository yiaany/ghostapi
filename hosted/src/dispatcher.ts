import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createQueue, dispatchOutbox } from "./worker.js";

const config = loadConfig();
const database = createDatabase(config);
const queue = createQueue(config);
let stopping = false;
let running = false;

async function tick(): Promise<void> {
  if (stopping || running) return;
  running = true;
  try {
    await dispatchOutbox(database, queue, config.qstashCallbackUrl, config.outboxMaxAttempts, config.workerMaxAttempts);
  } catch (error) {
    console.error("outbox_dispatch_failed", error instanceof Error ? error.message : "unknown_error");
  } finally {
    running = false;
  }
}

const timer = setInterval(() => void tick(), 250);
void tick();

async function shutdown(): Promise<void> {
  stopping = true;
  clearInterval(timer);
  while (running) await Bun.sleep(25);
  await database.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
