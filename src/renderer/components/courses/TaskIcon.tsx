import {
  AlarmClockCheck,
  ClipboardCheck,
  Code2,
  FlaskConical,
  Lightbulb,
  MessagesSquare,
  MonitorUp,
  NotebookPen,
  ScrollText,
  Target,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { TaskIconKey, TaskType } from "@/types/domain";
import { DEFAULT_TASK_ICON_KEY, matchTaskIcon } from "../../../shared/task-icon-matcher";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const TASK_ICON_OPTIONS: Array<{ key: TaskIconKey; label: string; Icon: IconComponent }> = [
  { key: "task-check", label: "作业", Icon: ClipboardCheck },
  { key: "essay-scroll", label: "论文", Icon: ScrollText },
  { key: "slides-screen", label: "展示", Icon: MonitorUp },
  { key: "project-target", label: "项目", Icon: Target },
  { key: "exam-clock", label: "考试", Icon: AlarmClockCheck },
  { key: "reading-notes", label: "阅读", Icon: NotebookPen },
  { key: "research-flask", label: "研究", Icon: FlaskConical },
  { key: "code-braces", label: "代码", Icon: Code2 },
  { key: "discussion-bubbles", label: "讨论", Icon: MessagesSquare },
  { key: "idea-lightbulb", label: "构思", Icon: Lightbulb },
];

const iconMap = new Map<TaskIconKey, IconComponent>(TASK_ICON_OPTIONS.map((option) => [option.key, option.Icon] as const));

export function resolveTaskIcon(input: { icon?: TaskIconKey; title?: string; taskType?: TaskType }): TaskIconKey {
  return input.icon || matchTaskIcon({ title: input.title, taskType: input.taskType }) || DEFAULT_TASK_ICON_KEY;
}

export function TaskIcon({
  task,
  className,
}: {
  task: { icon?: TaskIconKey; title?: string; taskType?: TaskType };
  className?: string;
}) {
  const Icon = iconMap.get(resolveTaskIcon(task)) || ClipboardCheck;
  return <Icon className={className} />;
}
