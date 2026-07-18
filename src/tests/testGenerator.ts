import type { ProxyEvent } from "../server/eventsStore.js";

export type GeneratedTest = {
  filename: string;
  content: string;
};

export function generateVitestFromEvent(event: ProxyEvent): GeneratedTest {
  const name = sanitizeName(`${event.method} ${event.path}`);
  const body = extractBody(event.request);
  const bodyLine = body === undefined ? "" : `,\n    body: JSON.stringify(${JSON.stringify(body, null, 6).replace(/^/gm, "    ").trim()})`;
  const headersLine = body === undefined ? "" : `,\n    headers: { "content-type": "application/json" }`;
  return {
    filename: `${name}.test.ts`,
    content: [
      "import { describe, expect, it } from \"vitest\";",
      "",
      `describe(${JSON.stringify(`GhostAPI ${event.provider}`)}, () => {`,
      `  it(${JSON.stringify(`${event.method} ${event.path} returns ${event.statusCode}`)}, async () => {`,
      `    const response = await fetch(\`http://127.0.0.1:8080${event.path}\`, {`,
      `      method: ${JSON.stringify(event.method)}${headersLine}${bodyLine}`,
      "    });",
      "",
      `    expect(response.status).toBe(${event.statusCode});`,
      "    await expect(response.json()).resolves.toMatchSnapshot();",
      "  });",
      "});",
      ""
    ].join("\n")
  };
}

function extractBody(request: unknown): unknown {
  if (request !== null && typeof request === "object" && "body" in request) return (request as { body?: unknown }).body;
  return undefined;
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "ghostapi-request";
}
