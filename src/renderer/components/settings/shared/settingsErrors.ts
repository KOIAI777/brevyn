export function errorMessage(error: unknown, fallback = "操作失败。"): string {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.trim() || fallback;
}
