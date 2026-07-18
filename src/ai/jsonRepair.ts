export function extractJson(text: string): string {
  let content = text.trim();

  // Remove markdown code blocks if the LLM wraps it
  if (content.startsWith("```json")) {
    content = content.slice(7);
  } else if (content.startsWith("```")) {
    content = content.slice(3);
  }

  if (content.endsWith("```")) {
    content = content.slice(0, -3);
  }

  return content.trim();
}

export function repairJson(text: string): unknown | null {
  const extracted = extractJson(text);

  try {
    return JSON.parse(extracted);
  } catch {
    // Basic repair if the LLM cuts off a bracket or leaves trailing commas
    try {
      const repaired = extracted.replace(/,\s*([\]}])/g, "$1");
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}