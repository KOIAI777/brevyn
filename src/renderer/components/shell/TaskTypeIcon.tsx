import { TaskIcon } from "@/components/courses/TaskIcon";
import type { BrevynTask } from "@/types/domain";

export function TaskTypeIcon({ task }: { task: BrevynTask }) {
  return <TaskIcon task={task} className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
}
