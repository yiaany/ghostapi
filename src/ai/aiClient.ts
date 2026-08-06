import type { ServerConfig } from "../config/serverConfig.js";

type AiMessage = {
  role: "system" | "user";
  content: string;
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

export async function askLLM(messages: AiMessage[], config: ServerConfig): Promise<string> {
  if (config.offline || config.allowExternalLlm !== true || !config.apiKey) {
    throw new Error("External LLM access requires explicit opt-in and GHOSTAPI_LLM_API_KEY");
  }

  // A basic OpenAI-compatible implementation. Since GPT-4o-mini / GPT-4o are standard defaults, 
  // OpenAI chat completions endpoint is assumed for MVP.
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    signal: AbortSignal.timeout(15_000),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.1
    })
  });

  if (!response.ok) {
    throw new Error(`LLM request failed with status ${response.status}`);
  }

  const json = await response.json() as ChatCompletionResponse;
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("Invalid LLM response shape");
  }

  return content;
}
