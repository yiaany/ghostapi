import { isJsonObject } from "../utils/json.js";
import { getDataPaths } from "../config/dataPaths.js";
import { atomicWriteJson, mutateJsonFile, readJsonFile, withFileLock } from "../storage/fileStore.js";
import { sanitizeSecrets } from "../security/secrets.js";

const sanitizeState = (value: unknown): Record<string, unknown> => {
  if (!isJsonObject(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, sanitizeSecrets(entryValue)]));
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
  await mutateJsonFile(getDataPaths().state, {}, sanitizeState, (state) => ({ ...state, [id]: sanitizeSecrets(obj) }));
}

export async function clearState(): Promise<void> {
  const statePath = getDataPaths().state;
  await withFileLock(statePath, () => atomicWriteJson(statePath, {}));
}
