export function parsePartialToolInput(
  value: string,
  options: { hintsOnly?: boolean; maxLength?: number } = {},
): unknown | null {
  const text = value.slice(0, options.maxLength ?? value.length).trim();
  if (!text) return null;
  if (options.hintsOnly) return partialToolInputHints(text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return partialToolInputHints(text);
  }
}

export function isCompleteToolInputJson(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

export function completePartialToolInputHints(value: string): Record<string, string> | null {
  const text = value.trim();
  if (!text) return null;
  const hints: Record<string, string> = {};
  for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
    const fieldValue = completeJsonStringField(text, key);
    if (fieldValue) hints[key] = fieldValue;
  }
  return Object.keys(hints).length > 0 ? hints : null;
}

function partialToolInputHints(text: string): Record<string, string> | null {
  const hints: Record<string, string> = {};
  for (const key of ["file_path", "filePath", "path", "command", "pattern", "query", "url", "skillId"]) {
    const value = partialJsonStringField(text, key);
    if (value) hints[key] = value;
  }
  return Object.keys(hints).length > 0 ? hints : null;
}

function partialJsonStringField(text: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`).exec(text);
  if (!match?.[1]) return "";
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\").trim();
  }
}

function completeJsonStringField(text: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(text);
  if (!match?.[1]) return "";
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\").trim();
  }
}
