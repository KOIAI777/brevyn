import type { CourseIconKey } from "../types/domain";

export interface CourseIconMatchInput {
  name?: string;
  code?: string;
  category?: string;
}

export const DEFAULT_COURSE_ICON_KEY: CourseIconKey = "graduation-cap";

const ICON_RULES: Array<{ icon: CourseIconKey; pattern: RegExp }> = [
  {
    icon: "scale",
    pattern: /\b(law|legal|juris|jurisprudence|constitutional|contract|criminal|civil|tort|litigation|court|evidence|justice)\b|法学|法律|宪法|刑法|民法|商法|诉讼|判例|法庭|合同|侵权/,
  },
  {
    icon: "square-pen",
    pattern: /\b(eap|writing|essay|composition|rhetoric|academic english|communication|argument|report)\b|写作|论文|学术英语|英语写作|应用文|沟通/,
  },
  {
    icon: "briefcase",
    pattern: /\b(business|management|marketing|accounting|commerce|entrepreneurship|strategy|operations|hr|human resource)\b|商科|商业|管理|市场|会计|创业|战略|运营|人力/,
  },
  {
    icon: "calculator",
    pattern: /\b(stat|statistics|math|mathematics|calculus|algebra|quant|quantitative|finance|economics|econ|data analytics)\b|统计|数学|微积分|代数|量化|金融|经济|数据分析/,
  },
  {
    icon: "globe",
    pattern: /\b(global|international|world|foreign|language|translation|cross-cultural|intercultural)\b|国际|全球|世界|外语|语言|翻译|跨文化/,
  },
  {
    icon: "microscope",
    pattern: /\b(research|method|methodology|lab|laboratory|science|scientific|psychology|biology|chemistry|physics|experiment)\b|研究|方法|实验|科学|心理|生物|化学|物理/,
  },
  {
    icon: "landmark",
    pattern: /\b(politic|political|government|governance|public policy|policy|history|historical|sociology|society|social science|anthropology|philosophy|ethics)\b|政治|政府|公共|政策|历史|社会|人类学|哲学|伦理/,
  },
  {
    icon: "presentation",
    pattern: /\b(seminar|presentation|workshop|studio|tutorial|colloquium|discussion)\b|研讨|展示|工作坊|讨论|讲习|汇报/,
  },
  {
    icon: "clipboard-list",
    pattern: /\b(exam|assessment|test|quiz|capstone|project)\b|考试|考核|测验|测试|大作业|项目/,
  },
  {
    icon: "book-open",
    pattern: /\b(reading|literature|text|book|novel|poetry|classic)\b|阅读|文学|文本|小说|诗歌|经典/,
  },
];

export function matchCourseIcon(input: CourseIconMatchInput): CourseIconKey {
  const haystack = normalizeCourseIconText([input.code, input.name, input.category].filter(Boolean).join(" "));
  if (!haystack) return DEFAULT_COURSE_ICON_KEY;
  return ICON_RULES.find((rule) => rule.pattern.test(haystack))?.icon || DEFAULT_COURSE_ICON_KEY;
}

function normalizeCourseIconText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
