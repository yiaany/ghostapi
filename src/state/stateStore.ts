import { isJsonObject } from "../utils/json.js";
import { getDataPaths } from "../config/dataPaths.js";
import { atomicWriteJson, mutateJsonFile, readJsonFile, withFileLock } from "../storage/fileStore.js";
import { sanitizeSecrets } from "../security/secrets.js";

export const MAX_STATE_ENTRIES = 5_000;
const MAX_STATE_ENTRY_BYTES = 512 * 1024;
const MAX_STATE_BYTES = 10 * 1024 * 1024;

const sanitizeState = (value: unknown): Record<string, unknown> => {
  if (!isJsonObject(value)) return {};
  return boundState(Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, sanitizeSecrets(entryValue)])));
};

export async function initializeStateStore(): Promise<void> {
  const statePath = getDataPaths().state;
  await withFileLock(statePath, async () => {
    const state = await readJsonFile(statePath, {}, sanitizeState);
    await atomicWriteJson(statePath, state);
  });
}

export async function getStateStore(): Promise<Record<string, unknown>> {
  return readJsonFile(getDataPaths().state, {}, sanitizeState);
}

export async function saveToStateStore(id: string, obj: unknown): Promise<void> {
  if (typeof id !== "string" || id.length === 0 || id.length > 512 || /[\r\n\0]/.test(id)) throw new Error("State key is invalid.");
  await mutateJsonFile(getDataPaths().state, {}, sanitizeState, (state) => boundState({ ...state, [id]: sanitizeSecrets(obj) }));
}

export async function transactState<T>(operation: (state: Readonly<Record<string, unknown>>) => { state: Record<string, unknown>; result: T }): Promise<T> {
  let result: T | undefined;
  await mutateJsonFile(getDataPaths().state, {}, sanitizeState, (state) => {
    const transaction = operation(structuredClone(state));
    result = transaction.result;
    return boundState(transaction.state);
  });
  if (result === undefined) throw new Error("Local state transaction did not return a result.");
  return result;
}

function boundState(state: Record<string, unknown>): Record<string, unknown> {
  const sanitized = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, sanitizeSecrets(value)]));
  const entries = Object.entries(sanitized);
  if (entries.length > MAX_STATE_ENTRIES) throw new Error(`State store is limited to ${MAX_STATE_ENTRIES} entries.`);
  for (const [key, value] of entries) {
    if (typeof key !== "string" || key.length === 0 || key.length > 512 || /[\r\n\0]/.test(key)) throw new Error("State key is invalid.");
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_STATE_ENTRY_BYTES) throw new Error("State entry exceeds its size limit.");
  }
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > MAX_STATE_BYTES) throw new Error("State store exceeds its aggregate size limit.");
  return sanitized;
}

export async function clearState(): Promise<void> {
  const statePath = getDataPaths().state;
  await withFileLock(statePath, () => atomicWriteJson(statePath, {}));
}
