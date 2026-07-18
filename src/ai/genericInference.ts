export type GenericServiceLabel =
  | "generic:gmail-like"
  | "generic:google-drive-like"
  | "generic:google-calendar-like"
  | "generic:gitlab-like"
  | "generic:slack-like"
  | "generic:notion-like"
  | "generic:linear-like"
  | "generic:jira-like"
  | "generic:trello-like"
  | "generic:airtable-like"
  | "generic:supabase-like"
  | "generic:firebase-like"
  | "generic:aws-like"
  | "generic:shopify-like"
  | "generic:hubspot-like"
  | "generic:salesforce-like"
  | "generic:sendgrid-like"
  | "generic:mailgun-like"
  | "generic:postmark-like"
  | "generic:openai-like"
  | "generic:anthropic-like"
  | "generic:deepseek-like"
  | "generic:gemini-like"
  | "generic:elevenlabs-like"
  | "generic:telegram-like"
  | "generic:whatsapp-like"
  | "generic:paypal-like"
  | "generic:plaid-like"
  | "generic:clerk-like"
  | "generic:auth0-like"
  | "generic:workos-like"
  | "generic:vercel-like"
  | "generic:netlify-like"
  | "generic:cloudflare-like"
  | "generic:docker-hub-like"
  | "generic:npm-registry-like"
  | "generic:rest-like";

const SERVICE_RULES: Array<{ label: GenericServiceLabel; patterns: RegExp[] }> = [
  { label: "generic:gmail-like", patterns: [/gmail/i, /\/messages\/send/i] },
  { label: "generic:google-drive-like", patterns: [/drive\/v\d/i, /\/files(?:\/|$)/i] },
  { label: "generic:google-calendar-like", patterns: [/calendar\/v\d/i, /\/calendars(?:\/|$)/i, /\/events(?:\/|$)/i] },
  { label: "generic:gitlab-like", patterns: [/gitlab/i, /\/projects\/[^/]+\/merge_requests/i] },
  { label: "generic:slack-like", patterns: [/slack/i, /\/api\/chat\.postMessage/i] },
  { label: "generic:notion-like", patterns: [/notion/i, /\/v\d\/pages(?=\/|\s|$)/i, /\/v\d\/databases(?=\/|\s|$)/i] },
  { label: "generic:linear-like", patterns: [/linear/i, /\/graphql(?:\/|$)/i] },
  { label: "generic:jira-like", patterns: [/jira/i, /\/rest\/api\/\d+\/issue/i] },
  { label: "generic:trello-like", patterns: [/trello/i, /\/1\/cards(?:\/|$)/i, /\/1\/boards(?:\/|$)/i] },
  { label: "generic:airtable-like", patterns: [/airtable/i, /\/v0\/app[a-z0-9]+/i] },
  { label: "generic:supabase-like", patterns: [/supabase/i, /\/rest\/v1(?:\/|$)/i] },
  { label: "generic:firebase-like", patterns: [/firebase/i, /firestore/i, /\/v1\/projects\/[^/]+\/databases/i] },
  { label: "generic:aws-like", patterns: [/amazonaws/i, /\/s3\//i, /\bqueueurl\b/i, /\baction=(?:sendemail|publish|sendmessage)/i] },
  { label: "generic:shopify-like", patterns: [/shopify/i, /\/admin\/api\//i, /products\.json/i] },
  { label: "generic:hubspot-like", patterns: [/hubspot/i, /\/crm\/v3\//i] },
  { label: "generic:salesforce-like", patterns: [/salesforce/i, /\/services\/data\/v/i] },
  { label: "generic:sendgrid-like", patterns: [/sendgrid/i, /\/v3\/mail\/send/i] },
  { label: "generic:mailgun-like", patterns: [/mailgun/i, /\/messages(?:\/|$)/i] },
  { label: "generic:postmark-like", patterns: [/postmark/i, /\/email(?:\/|$)/i] },
  { label: "generic:openai-like", patterns: [/openai/i, /\/v1\/(?:chat\/completions|responses|embeddings)/i] },
  { label: "generic:anthropic-like", patterns: [/anthropic/i, /\/v1\/messages/i] },
  { label: "generic:deepseek-like", patterns: [/deepseek/i] },
  { label: "generic:gemini-like", patterns: [/gemini/i, /generativelanguage/i] },
  { label: "generic:elevenlabs-like", patterns: [/elevenlabs/i, /\/v1\/text-to-speech/i] },
  { label: "generic:telegram-like", patterns: [/telegram/i, /\/bot[^/]+\/sendMessage/i] },
  { label: "generic:whatsapp-like", patterns: [/whatsapp/i, /\/messages(?:\/|$)/i] },
  { label: "generic:paypal-like", patterns: [/paypal/i, /\/v\d\/checkout\/orders/i] },
  { label: "generic:plaid-like", patterns: [/plaid/i, /\/transactions\//i] },
  { label: "generic:clerk-like", patterns: [/clerk/i, /\/v1\/users(?:\/|$)/i] },
  { label: "generic:auth0-like", patterns: [/auth0/i, /\/api\/v2\//i] },
  { label: "generic:workos-like", patterns: [/workos/i, /\/user_management\//i] },
  { label: "generic:vercel-like", patterns: [/vercel/i, /\/v\d\/projects(?:\/|$)/i] },
  { label: "generic:netlify-like", patterns: [/netlify/i, /\/api\/v\d\/sites/i] },
  { label: "generic:cloudflare-like", patterns: [/cloudflare/i, /\/client\/v4\//i] },
  { label: "generic:docker-hub-like", patterns: [/docker/i, /\/v2\/repositories/i] },
  { label: "generic:npm-registry-like", patterns: [/registry\.npmjs/i, /\/-\/package\//i] }
];

export function inferGenericService(path: string, query: Record<string, unknown> = {}, body: unknown = null): GenericServiceLabel {
  const haystack = `${path}\n${JSON.stringify(query)}\n${JSON.stringify(body)}`;
  for (const rule of SERVICE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) {
      return rule.label;
    }
  }
  return "generic:rest-like";
}

export function inferResourceName(path: string): string {
  const segments = pathWithoutQuery(path)
    .split("/")
    .filter(Boolean)
    .filter((segment) => !/^v\d+(?:\.\d+)?$/i.test(segment) && segment !== "api" && segment !== "admin");

  const last = segments.at(-1)?.replace(/\.json$/i, "") ?? "resource";
  const candidate = isLikelyId(last) ? segments.at(-2) ?? "resource" : last;
  return singularize(candidate.replace(/[^a-z0-9_-]/gi, "_").toLowerCase()) || "resource";
}

export function isLikelyCollectionPath(method: string, path: string): boolean {
  if (method !== "GET") return false;
  const last = pathWithoutQuery(path).split("/").filter(Boolean).at(-1) ?? "";
  return !isLikelyId(last) && (/s(?:\.json)?$/i.test(last) || last.includes("."));
}

export function isLikelyResourceByIdPath(path: string): boolean {
  const last = pathWithoutQuery(path).split("/").filter(Boolean).at(-1) ?? "";
  return isLikelyId(last);
}

function pathWithoutQuery(path: string): string {
  return path.split(/[?#]/)[0] ?? path;
}

function isLikelyId(value: string): boolean {
  return /^[a-z]+_[a-z0-9]+$/i.test(value) || /^[a-z]+-\d+$/i.test(value) || /^[0-9a-f-]{8,}$/i.test(value) || /^\d{4,}$/.test(value);
}

function singularize(value: string): string {
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s") && value.length > 1) return value.slice(0, -1);
  return value;
}
