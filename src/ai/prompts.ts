import type { ProviderName } from "../providers/types.js";
import { inferGenericService, inferResourceName, isLikelyCollectionPath, isLikelyResourceByIdPath } from "./genericInference.js";

export function getSystemPrompt(provider: ProviderName): string {
  const base = `You are GhostAPI, an autonomous local internet simulator.
Your job is to generate a realistic JSON response for a given authenticated HTTP request to an external API.
Return ONLY valid JSON. No markdown wrapping unless explicitly requested, no explanations, no text before or after the JSON.
Keep IDs seemingly real, but prefixed with mock identifiers where appropriate (e.g. mock_cus_123).
`;

  switch (provider) {
    case "stripe":
      return `${base}
- This is the Stripe API.
- Use Stripe object structures (e.g., {"object": "charge", ...}).
- IDs usually start with prefixes like ch_, cus_, pi_. Use mock_ch_, mock_cus_, etc.
- In lists, wrap results in {"object": "list", "data": [], "has_more": false}.
`;
    case "twilio":
      return `${base}
- This is the Twilio REST API.
- Use Twilio structures. Return SID, account_sid, date_created, etc.
- Always include 'uri' ending in .json.
`;
    case "resend":
      return `${base}
- This is the Resend Email API.
- The standard response for sending an email is a single object with an 'id' string.
`;
    case "github":
      return `${base}
- This is the GitHub REST API.
- Use exact GitHub payload shapes.
`;
    case "discord":
      return `${base}
- This is the Discord REST API.
- Discord IDs are large integers represented as strings.
`;
    case "openai":
      return `${base}
- This is the OpenAI API.
- Use OpenAI-like response objects such as chat.completion, response, embedding, model, file, or image generation depending on the path.
- IDs should use realistic mock prefixes like chatcmpl_mock_, resp_mock_, embd_mock_, model_mock_, file_mock_, or img_mock_.
- For chat completions, include choices with message objects and usage token counts.
- For embeddings, include object: "list", data entries, model, and usage.
- For model/file lists, wrap results in {"object":"list","data":[]}.
`;
    case "generic":
    default:
      return `${base}
- This is the generic fallback, not a full official API implementation.
- Analyze the URL path, method, query, and body to infer the service style and resource type.
- Preserve safe request body fields in the response when it makes sense, especially names, emails, titles, amounts, status, metadata, message content, and IDs supplied by the caller.
- Generate mock IDs from the inferred singular resource name: product_mock_xxx, message_mock_xxx, issue_mock_xxx, page_mock_xxx, file_mock_xxx, etc.
- If the path looks like a collection endpoint, return either a JSON array or a list object with data/items/results according to the service style.
- If the path looks like a resource-by-id endpoint, return one object matching that resource.
- For create/update methods, return one created or updated object and echo relevant body fields.
- Keep the response small, deterministic-looking, and useful for local agent testing.
`;
  }
}

export function getUserPrompt(method: string, path: string, query: Record<string, unknown>, body: unknown, provider: ProviderName = "generic"): string {
  const genericContext = provider === "generic" ? buildGenericPromptContext(method, path, query, body) : "";

  return `Generate a realistic JSON response for this request:
Method: ${method}
Path: ${path}
Query: ${JSON.stringify(query)}
Body: ${JSON.stringify(body)}
${genericContext}
`;
}

export function buildGenericPromptContext(method: string, path: string, query: Record<string, unknown>, body: unknown): string {
  const serviceLabel = inferGenericService(path, query, body);
  const resourceName = inferResourceName(path);
  const endpointShape = isLikelyCollectionPath(method, path) ? "collection" : isLikelyResourceByIdPath(path) ? "resource-by-id" : "mutation-or-action";

  return `Generic fallback context:
Service label: ${serviceLabel}
Inferred resource: ${resourceName}
Endpoint shape: ${endpointShape}
ID format: ${resourceName}_mock_<short_random_suffix>
Body echo rule: copy safe, relevant body fields into the response instead of inventing unrelated values.`;
}
