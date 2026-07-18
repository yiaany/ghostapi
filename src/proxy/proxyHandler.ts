import type { Request, Response } from "express";
import { generateAiMock } from "../ai/aiGenerator.js";
import { getCachedResponse, setCachedResponse } from "../cache/index.js";
import { createCacheKey } from "./cacheKey.js";
import { detectProvider } from "./providerDetector.js";
import { normalizeRequest } from "./requestNormalizer.js";
import { extractIdFromResponse } from "../state/stateExtractor.js";
import { resolveState } from "../state/stateResolver.js";
import { saveToStateStore } from "../state/stateStore.js";
import { validateRequest, createProviderError } from "../errors/index.js";
import type { ServerConfig } from "../config/serverConfig.js";
import { addEvent, type EventSource } from "../server/eventsStore.js";
import { broadcastEvent } from "../server/sse.js";
import { inferGenericService } from "../ai/genericInference.js";
import { decideFault, waitForFault } from "../fault/faultLab.js";
import { findApiBehavior } from "../behavior/behaviorStore.js";


export async function proxyHandler(request: Request, response: Response, config: ServerConfig): Promise<void> {
  const t0 = performance.now();
  const provider = detectProvider({ path: request.path, headers: request.headers, query: request.query, body: request.body });
  const normalizedRequest = normalizeRequest(request);
  const providerLabel = provider === "generic" ? inferGenericService(normalizedRequest.path, normalizedRequest.query, normalizedRequest.body) : provider;
  
  async function completeRequest(source: EventSource, status: number, body: unknown) {
    const durationMs = Math.round(performance.now() - t0);
    const event = {
      id: `evt_${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
      provider: providerLabel,
      method: normalizedRequest.method,
      path: normalizedRequest.path,
      statusCode: status,
      source,
      durationMs,
      request: {
        query: normalizedRequest.query,
        headers: normalizedRequest.headers,
        body: normalizedRequest.body
      },
      response: body
    };
    await addEvent(event);
    broadcastEvent(event);
  }

  const behavior = await findApiBehavior(normalizedRequest);
  if (behavior !== null) {
    for (const [key, value] of Object.entries(behavior.headers ?? {})) {
      response.setHeader(key, value);
    }
    response.setHeader("x-ghostapi-behavior", "HIT");
    response.status(behavior.status).json(behavior.body);
    await completeRequest("behavior", behavior.status, behavior.body);
    return;
  }

  const fault = decideFault(provider);
  if (fault.type === "error") {
    await waitForFault(fault.latencyMs);
    response.setHeader("x-ghostapi-fault-lab", "error");
    response.setHeader("retry-after", String(fault.retryAfterSeconds));
    response.status(fault.statusCode).json(fault.body);
    await completeRequest("fault", fault.statusCode, fault.body);
    return;
  }

  if (fault.type === "delay") {
    response.setHeader("x-ghostapi-fault-lab", "delay");
    await waitForFault(fault.latencyMs);
  }

  const validationError = validateRequest(normalizedRequest, provider);
  if (validationError !== null) {
    const formattedError = createProviderError(provider, validationError);
    response.status(validationError.status).json(formattedError);
    await completeRequest("error", validationError.status, formattedError);
    return;
  }

  const stateResolution = await resolveState(normalizedRequest, provider);
  if (stateResolution !== null) {
    for (const [key, value] of Object.entries(stateResolution.headers)) {
      response.setHeader(key, value);
    }
    response.status(stateResolution.status).json(stateResolution.body);
    await completeRequest("state", stateResolution.status, stateResolution.body);
    return;
  }

  const cacheKey = createCacheKey(normalizedRequest, provider);
  const cachedResponse = await getCachedResponse(provider, cacheKey);

  if (cachedResponse !== null) {
    for (const [key, value] of Object.entries(cachedResponse.headers)) {
      response.setHeader(key, value);
    }
    response.setHeader("x-ghostapi-cache", "HIT");
    response.status(cachedResponse.status).json(cachedResponse.body);
    await completeRequest("cache", cachedResponse.status, cachedResponse.body);
    return;
  }

  const generatedOption = await generateAiMock(normalizedRequest, provider, response, config);

  if (generatedOption === "streamed") {
    await completeRequest("stream", 200, { streamed: true });
    return;
  }

  await setCachedResponse(provider, cacheKey, {
    status: generatedOption.status,
    headers: generatedOption.headers,
    body: generatedOption.body
  });

  if (["POST", "PUT", "PATCH"].includes(normalizedRequest.method)) {
    const extractedId = extractIdFromResponse(generatedOption.body);
    if (extractedId !== undefined) {
      await saveToStateStore(`${provider}:${extractedId}`, generatedOption.body);
    }
  }

  for (const [key, value] of Object.entries(generatedOption.headers)) {
    response.setHeader(key, value);
  }
  
  response.setHeader("x-ghostapi-cache", "MISS");
  response.status(generatedOption.status).json(generatedOption.body);
  await completeRequest(generatedOption.status >= 400 ? "error" : (String(generatedOption.body)?.includes("mock_response") ? "fallback" : "ai"), generatedOption.status, generatedOption.body);
}
