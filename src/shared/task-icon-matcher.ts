import type { TaskIconKey } from "../types/domain";

export interface TaskIconMatchInput {
  title?: string;
  taskType?: string;
}

export const DEFAULT_TASK_ICON_KEY: TaskIconKey = "task-check";

const ICON_RULES: Array<{ icon: TaskIconKey; pattern: RegExp }> = [
  {
    icon: "exam-clock",
    pattern: /\b(exam|quiz|test|midterm|final|assessment)\b|考试|测验|测试|期中|期末|考核/,
  },
  {
    icon: "essay-scroll",
    pattern: /\b(essay|paper|report|writing|reflection|article)\b|论文|报告|写作|作文|反思/,
  },
  {
    icon: "slides-screen",
    pattern: /\b(presentation|present|slides|speech|demo|pitch)\b|展示|汇报|演示|演讲|答辩/,
  },
  {
    icon: "project-target",
    pattern: /\b(project|case|portfolio|capstone|deliverable)\b|项目|案例|作品集|大作业|交付/,
  },
  {
    icon: "reading-notes",
    pattern: /\b(reading|read|notes|journal|annotation|summary)\b|阅读|读书|笔记|札记|摘要/,
  },
  {
    icon: "research-flask",
    pattern: /\b(research|lab|experiment|survey|data|method)\b|研究|实验|调研|数据|方法/,
  },
  {
    icon: "code-braces",
    pattern: /\b(code|coding|program|programming|github|repo|script)\b|代码|编程|程序|脚本/,
  },
  {
    icon: "discussion-bubbles",
    pattern: /\b(discussion|debate|forum|peer|comment|critique)\b|讨论|辩论|论坛|互评|评论/,
  },
  {
    icon: "idea-lightbulb",
    pattern: /\b(proposal|plan|idea|design|draft|outline)\b|提案|计划|创意|设计|草稿|大纲/,
  },
];

export function matchTaskIcon(input: TaskIconMatchInput): TaskIconKey {
  const haystack = normalizeTaskIconText([input.title, input.taskType].filter(Boolean).join(" "));
  if (!haystack) return DEFAULT_TASK_ICON_KEY;
  return ICON_RULES.find((rule) => rule.pattern.test(haystack))?.icon || DEFAULT_TASK_ICON_KEY;
}

function normalizeTaskIconText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
