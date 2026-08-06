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
import { sanitizeSecrets } from "../security/secrets.js";
import { getProviderPack } from "../providers/registry.js";
import { assertProviderStateTransition, getProviderPackHeaders, prepareProviderPackExecution } from "../providers/runtime.js";
import { createProviderRuntime } from "../providers/runtime.js";
import type { ProviderPackExecution } from "../providers/types.js";
import { transactState } from "../state/stateStore.js";
import { corruptStripeWebhookSignature, createStripeWebhookSignature, isStripeWebhookDeliveryRequest, readStripeWebhookDelivery } from "../providers/stripeWebhook.js";


export async function proxyHandler(request: Request, response: Response, config: ServerConfig): Promise<void> {
  const t0 = performance.now();
  const provider = detectProvider({ path: request.path, headers: request.headers, query: request.query, body: request.body });
  const normalizedRequest = normalizeRequest(request);
  const providerLabel = provider === "generic" ? inferGenericService(normalizedRequest.path, normalizedRequest.query, normalizedRequest.body) : provider;
  const pack = getProviderPack(provider);
  const preparedPack = pack === null ? null : prepareProviderPackExecution(pack, normalizedRequest);
  const packExecution: ProviderPackExecution | undefined = preparedPack !== null && !("error" in preparedPack) ? preparedPack : undefined;

  if (packExecution !== undefined) {
    for (const [key, value] of Object.entries(getProviderPackHeaders(packExecution))) response.setHeader(key, value);
    for (const [key, value] of Object.entries(packExecution.pack.createResponseHeaders({ apiVersion: packExecution.apiVersion, runtime: packExecution.runtime }))) response.setHeader(key, value);
  } else if (pack !== null && preparedPack !== null && "error" in preparedPack) {
    for (const [key, value] of Object.entries(pack.createResponseHeaders({ apiVersion: pack.manifest.apiVersions.default, runtime: createProviderRuntime() }))) response.setHeader(key, value);
  }
  
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
      response: sanitizeSecrets(body)
    };
    const safeEvent = await addEvent(event);
    broadcastEvent(safeEvent);
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

  const fault = await decideFault(provider);
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

  if (preparedPack !== null && "error" in preparedPack) {
    const formattedError = createProviderError(provider, preparedPack.error);
    response.setHeader("x-ghostapi-provider-pack", `${pack!.name}@${pack!.manifest.packVersion}`);
    response.status(preparedPack.error.status).json(formattedError);
    await completeRequest("error", preparedPack.error.status, formattedError);
    return;
  }

  const validationError = validateRequest(normalizedRequest, provider, packExecution);
  if (validationError !== null) {
    const formattedError = createProviderError(provider, validationError);
    response.status(validationError.status).json(formattedError);
    await completeRequest("error", validationError.status, formattedError);
    return;
  }

  if (packExecution?.pack.stateful) {
    const generatedOption = await transactState((state) => {
      const runtime = createProviderRuntime({ state: { snapshot: () => structuredClone(state) } });
      const execution = prepareProviderPackExecution(packExecution.pack, normalizedRequest, runtime);
      if ("error" in execution) throw new Error(`Provider pack version changed during execution: ${execution.error.message}`);
      const generated = execution.pack.handleDeterministic({
        request: normalizedRequest,
        parsedRequest: execution.parsedRequest,
        apiVersion: execution.apiVersion,
        runtime: execution.runtime
      });
      const transition = execution.pack.transitionState({
        request: normalizedRequest,
        response: generated,
        apiVersion: execution.apiVersion,
        runtime: execution.runtime
      });
      if (transition === null) return { state, result: generated };
      assertProviderStateTransition(execution.pack, transition);
      return {
        state: {
          ...state,
          [transition.key]: transition.value,
          ...Object.fromEntries((transition.additionalWrites ?? []).map((write) => [write.key, write.value]))
        },
        result: generated
      };
    });

    for (const [key, value] of Object.entries(generatedOption.headers)) response.setHeader(key, value);
    response.setHeader("x-ghostapi-cache", "BYPASS");
    if (normalizedRequest.method === "GET" && generatedOption.status < 400) response.setHeader("x-ghostapi-state", "HIT");

    if (packExecution.pack.name === "stripe" && isStripeWebhookDeliveryRequest(normalizedRequest)) {
      const delivery = readStripeWebhookDelivery(normalizedRequest.query);
      if (delivery.error !== null) {
        const body = packExecution.pack.formatError(delivery.error);
        response.status(delivery.error.status).json(body);
        await completeRequest("error", delivery.error.status, body);
        return;
      }
      if (delivery.delayMs > 0) await waitForFault(delivery.delayMs);
      const payload = JSON.stringify(generatedOption.body);
      const signature = createStripeWebhookSignature(payload);
      response.setHeader("stripe-signature", delivery.mode === "invalid_signature" ? corruptStripeWebhookSignature(signature) : signature);
      response.setHeader("x-ghostapi-webhook-delivery", delivery.mode);
      response.status(generatedOption.status).type("application/json").send(payload);
      await completeRequest("state", generatedOption.status, generatedOption.body);
      return;
    }

    response.status(generatedOption.status).json(generatedOption.body);
    await completeRequest(generatedOption.status >= 400 ? "error" : "state", generatedOption.status, generatedOption.body);
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

  const generatedOption = await generateAiMock(normalizedRequest, provider, response, config, packExecution);

  if (generatedOption === "streamed") {
    await completeRequest("stream", 200, { streamed: true });
    return;
  }

  await setCachedResponse(provider, cacheKey, {
    status: generatedOption.status,
    headers: generatedOption.headers,
    body: generatedOption.body
  });

  if (packExecution !== undefined) {
      const transition = packExecution.pack.transitionState({
      request: normalizedRequest,
      response: generatedOption,
      apiVersion: packExecution.apiVersion,
      runtime: packExecution.runtime
    });
      if (transition !== null) {
        assertProviderStateTransition(packExecution.pack, transition);
        await saveToStateStore(transition.key, transition.value);
        for (const write of transition.additionalWrites ?? []) {
          await saveToStateStore(write.key, write.value);
        }
      }
  } else if (["POST", "PUT", "PATCH"].includes(normalizedRequest.method)) {
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
