export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasBooleanFlag(value: unknown, flag: string): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return value[flag] === true || value[flag] === "true";
}
