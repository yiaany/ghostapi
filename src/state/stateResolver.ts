import type { NormalizedRequest } from "../proxy/requestNormalizer.js";
import { extractIdFromPath } from "./stateExtractor.js";
import { getStateStore, saveToStateStore } from "./stateStore.js";
import { isJsonObject } from "../utils/json.js";

type ResolvedState = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export async function resolveState(request: NormalizedRequest, provider: string): Promise<ResolvedState | null> {
  const stateStore = await getStateStore();

  const idToLookUp = extractIdFromPath(request);
  const resourceNamespace = resolveNamespace(request);

  if (request.method === "GET") {
    if (idToLookUp !== undefined) {
      const stateKey = `${provider}:${idToLookUp}`;
      const found = stateStore[stateKey];
      if (found !== undefined) {
        return createResponse(found);
      }
    } else if (resourceNamespace !== undefined) {
      const list = Object.keys(stateStore)
        .filter((key) => key.startsWith(`${provider}:`) && objectMatchesNamespace(stateStore[key], resourceNamespace))
        .map((key) => stateStore[key]);
      
      const formattedList = formatProviderList(provider, list);
      return createResponse(formattedList);
    }
  }

  if (request.method === "DELETE" && idToLookUp !== undefined) {
    const stateKey = `${provider}:${idToLookUp}`;
    const found = stateStore[stateKey];

    if (found !== undefined) {
      const deletedObj = formatProviderDelete(provider, found, idToLookUp);
      await saveToStateStore(stateKey, deletedObj);
      return createResponse(deletedObj);
    }
  }

  return null;
}

function resolveNamespace(request: NormalizedRequest): string | undefined {
  const segments = request.path.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  
  const id = extractIdFromPath(request);
  
  if (id !== undefined && segments.length >= 2) {
    // If it's an item path like /v1/customers/cus_1, namespace is "customers"
    return segments[segments.length - 2]?.toLowerCase();
  }
  
  // If it's a list path like /v1/customers, namespace is "customers"
  return segments[segments.length - 1]?.toLowerCase();
}

function objectMatchesNamespace(obj: unknown, expectedNamespace: string): boolean {
  if (!isJsonObject(obj) || typeof obj.object !== "string") {
    // Basic fallback: include all provider items if namespace checking is too rigid without object shapes
    return true;
  }
  
  // Ex: "customer" matches namespace "customers"
  return expectedNamespace.startsWith(obj.object.toLowerCase());
}

function formatProviderList(provider: string, list: unknown[]): unknown {
  if (provider === "stripe") {
    return {
      object: "list",
      data: list,
      has_more: false,
      url: `/v1/list_placeholder` // Placeholder
    };
  }

  if (provider === "openai") {
    return {
      object: "list",
      data: list
    };
  }

  return {
    data: list,
    total: list.length
  };
}

function formatProviderDelete(provider: string, existingObj: unknown, id: string): unknown {
  if (provider === "stripe") {
    return {
      id,
      object: isJsonObject(existingObj) && typeof existingObj.object === "string" ? existingObj.object : "removed_object",
      deleted: true
    };
  }

  if (isJsonObject(existingObj)) {
    return { ...existingObj, deleted: true };
  }

  return { id, deleted: true };
}

function createResponse(body: unknown): ResolvedState {
  return {
    status: 200,
    headers: { "content-type": "application/json", "x-ghostapi-state": "HIT" },
    body
  };
}
