import type { BrevynTask } from "../../../../types/domain";

export function formatArchiveDate(value?: string): string {
  if (!value) return "未知";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleDateString("zh-CN", { month: "short", day: "numeric", year: "numeric" });
}

export function displayArchivedTaskStatus(status: BrevynTask["status"]): string {
  if (status === "in_progress") return "进行中";
  if (status === "due_soon") return "即将截止";
  if (status === "done") return "已完成";
  return "未开始";
}

export function shortId(value: string): string {
  return value.replace(/^(course|task|thread|semester)-/, "").slice(0, 8) || value;
}
