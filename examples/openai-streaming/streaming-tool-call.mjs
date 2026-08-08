const baseUrl = process.env.GHOSTAPI_OPENAI_BASE_URL ?? "http://127.0.0.1:8080/v1";

const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "sk-ghostapi"}`
  },
  body: JSON.stringify({
    model: "gpt-4o-mini",
    stream: true,
    messages: [{ role: "user", content: "Return a local weather tool call for Berlin." }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Return local test weather.",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
        }
      }
    ]
  })
});

if (!response.ok) throw new Error(`GhostAPI OpenAI request failed: ${response.status} ${await response.text()}`);

const text = await response.text();
if (!text.includes("[DONE]")) throw new Error("Expected a local streaming completion terminator.");

console.log("OpenAI streaming/tool-call starter completed against local GhostAPI.");
