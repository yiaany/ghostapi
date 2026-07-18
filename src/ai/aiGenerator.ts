import type { Response } from "express";
import type { NormalizedRequest } from "../proxy/requestNormalizer.js";
import type { ServerConfig } from "../config/serverConfig.js";
import { hasBooleanFlag } from "../utils/json.js";
import { askLLM } from "./aiClient.js";
import { getSystemPrompt, getUserPrompt } from "./prompts.js";
import { repairJson } from "./jsonRepair.js";
import { createProviderError } from "../errors/index.js";
import type { ProviderName } from "../providers/types.js";
import { inferResourceName, isLikelyCollectionPath } from "./genericInference.js";

export type AiMockResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export async function generateAiMock(request: NormalizedRequest, provider: ProviderName, response: Response, config: ServerConfig): Promise<AiMockResponse | "streamed"> {
  const isStreamRequested = hasBooleanFlag(request.body, "stream") || hasBooleanFlag(request.query, "stream") || request.headers.accept === "text/event-stream";

  if (isStreamRequested) {
    return handleStreamResponse(request, provider, response);
  }

  let body: unknown = null;

  if (config.offline || !config.apiKey) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: generateOfflineMock(request, provider)
    };
  }

  try {
    const systemPrompt = getSystemPrompt(provider);
    const userPrompt = getUserPrompt(request.method, request.path, request.query, request.body, provider);
    
    const textOutput = await askLLM([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], config);

    const repaired = repairJson(textOutput);
    if (repaired === null) {
      return {
        status: 500,
        headers: { "content-type": "application/json" },
        body: createProviderError(provider, { status: 500, type: "api_error", message: "Failed to generate valid JSON from AI." })
      };
    }

    body = repaired;
  } catch (error) {
    body = generateOfflineMock(request, provider);
  }

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body
  };
}

function generateOfflineMock(request: NormalizedRequest, provider: string): unknown {
  if (provider === "generic") {
    return generateGenericOfflineMock(request);
  }

  if (provider === "stripe") return generateStripeOfflineMock(request);
  if (provider === "openai") return generateOpenAiOfflineMock(request);
  if (provider === "twilio") return generateTwilioOfflineMock(request);
  if (provider === "resend") return generateResendOfflineMock(request);
  if (provider === "github") return generateGithubOfflineMock(request);
  if (provider === "discord") return generateDiscordOfflineMock(request);

  const mockId = `mock_${provider}_${Date.now().toString(36)}`;
  const segments = request.path.split("/").filter(Boolean);
  const resourceType = segments.length >= 2 ? (segments.length % 2 === 1 ? segments[segments.length - 2] : segments[segments.length - 1]) : "mock_response";

  return {
    id: mockId,
    object: resourceType ? resourceType.replace(/s$/i, "") : "mock_response",
    provider,
    method: request.method,
    path: request.path,
    status: "ok"
  };
}

function generateStripeOfflineMock(request: NormalizedRequest): unknown {
  const path = request.path;
  const body = copyObjectBody(request.body);

  if (isLikelyCollectionPath(request.method, path)) {
    return annotateMock({ object: "list", data: [annotateMock(stripeObjectForPath(path, body), request, "stripe")], has_more: false, url: path }, request, "stripe");
  }

  return annotateMock(stripeObjectForPath(path, body), request, "stripe");
}

function stripeObjectForPath(path: string, body: Record<string, unknown>): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);

  if (path.includes("/payment_intents")) {
    return {
      id: `pi_mock_${Date.now().toString(36)}`,
      object: "payment_intent",
      amount: readNumber(body.amount, 2000),
      currency: readString(body.currency, "usd"),
      status: body.confirm === true || body.confirm === "true" ? "succeeded" : "requires_payment_method",
      client_secret: `pi_mock_secret_${Date.now().toString(36)}`,
      livemode: false,
      created: now,
      metadata: readRecord(body.metadata)
    };
  }

  if (path.includes("/customers")) {
    return {
      id: `cus_mock_${Date.now().toString(36)}`,
      object: "customer",
      email: readString(body.email, "customer@example.com"),
      name: readString(body.name, "GhostAPI Customer"),
      livemode: false,
      created: now,
      metadata: readRecord(body.metadata)
    };
  }

  if (path.includes("/checkout/sessions")) {
    return {
      id: `cs_test_mock_${Date.now().toString(36)}`,
      object: "checkout.session",
      mode: readString(body.mode, "payment"),
      payment_status: "paid",
      status: "complete",
      url: "https://checkout.stripe.com/c/pay/mock_ghostapi",
      livemode: false,
      created: now
    };
  }

  return {
    id: `stripe_mock_${Date.now().toString(36)}`,
    object: inferResourceName(path),
    livemode: false,
    created: now,
    ...body
  };
}

function generateOpenAiOfflineMock(request: NormalizedRequest): unknown {
  const model = readString(copyObjectBody(request.body).model, "gpt-4o-mini");
  if (request.path.includes("/chat/completions")) {
    return annotateMock({
      id: `chatcmpl_mock_${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "Mock response from GhostAPI." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
    }, request, "openai");
  }
  return annotateMock({ id: `openai_mock_${Date.now().toString(36)}`, object: inferResourceName(request.path), model, created: Math.floor(Date.now() / 1000) }, request, "openai");
}

function generateTwilioOfflineMock(request: NormalizedRequest): unknown {
  const body = copyObjectBody(request.body);
  return annotateMock({
    sid: `SM${Date.now().toString(36).padEnd(32, "0").slice(0, 32)}`,
    account_sid: "AC00000000000000000000000000000000",
    status: "queued",
    direction: "outbound-api",
    from: readString(body.From ?? body.from, "+15550000001"),
    to: readString(body.To ?? body.to, "+15550000002"),
    body: readString(body.Body ?? body.body, "Mock message from GhostAPI."),
    date_created: new Date().toUTCString()
  }, request, "twilio");
}

function generateResendOfflineMock(request: NormalizedRequest): unknown {
  return annotateMock({ id: `email_mock_${Date.now().toString(36)}` }, request, "resend");
}

function generateGithubOfflineMock(request: NormalizedRequest): unknown {
  const body = copyObjectBody(request.body);
  return annotateMock({
    id: Date.now(),
    node_id: `NODE_mock_${Date.now().toString(36)}`,
    name: readString(body.name, inferResourceName(request.path)),
    full_name: readString(body.full_name, `ghostapi/${inferResourceName(request.path)}`),
    html_url: "https://github.com/ghostapi/mock",
    private: false
  }, request, "github");
}

function generateDiscordOfflineMock(request: NormalizedRequest): unknown {
  const body = copyObjectBody(request.body);
  return annotateMock({
    id: String(Date.now()),
    type: 0,
    content: readString(body.content, "Mock Discord message from GhostAPI."),
    channel_id: "000000000000000000",
    author: { id: "000000000000000001", username: "ghostapi", bot: true },
    timestamp: new Date().toISOString(),
    path: request.path
  }, request, "discord");
}

function generateGenericOfflineMock(request: NormalizedRequest): unknown {
  const resource = inferResourceName(request.path);
  const base = {
    id: `${resource}_mock_${Date.now().toString(36)}`,
    object: resource,
    provider: "generic",
    method: request.method,
    path: request.path,
    status: "ok",
    ...copyObjectBody(request.body)
  };

  if (isLikelyCollectionPath(request.method, request.path)) {
    return {
      object: "list",
      data: [base],
      has_more: false
    };
  }

  return base;
}

function copyObjectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function annotateMock<T extends Record<string, unknown>>(body: T, request: NormalizedRequest, provider: string): T & { provider: string; method: string; path: string } {
  return { ...body, provider, method: request.method, path: request.path };
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function handleStreamResponse(request: NormalizedRequest, provider: string, response: Response): Promise<"streamed"> {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("x-ghostapi-cache", "MISS");
  response.flushHeaders();

  const mockId = `mock_stream_${provider}_${Date.now().toString(36)}`;
  
  response.write(`data: ${JSON.stringify({ id: mockId, object: "chunk", status: "started" })}\n\n`);
  
  await new Promise((resolve) => setTimeout(resolve, 100));

  response.write(`data: ${JSON.stringify({ id: mockId, object: "chunk", status: "completed" })}\n\n`);
  response.write(`data: [DONE]\n\n`);
  
  response.end();

  return "streamed";
}
