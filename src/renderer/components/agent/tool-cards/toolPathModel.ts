export function getToolInputPath(input: unknown): string {
  const data = recordObject(input);
  return stringValue(data.file_path ?? data.filePath ?? data.path ?? data.notebook_path, "");
}

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}
