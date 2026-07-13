import type {
  BrevynTask,
  CourseTaskDocument,
  CourseTaskInfo,
  CourseTaskInfoManualField,
  CourseTaskRequirement,
  CourseTaskRubricCriterion,
} from "../types/domain";

export interface AgentCourseTaskInfoRefresh {
  summary: string;
  dueAt?: string;
  deliverable?: string;
  requirements: CourseTaskRequirement[];
  rubricCriteria: CourseTaskRubricCriterion[];
  documents: CourseTaskDocument[];
  extractedAt: string;
}

export function mergeAgentCourseTaskInfo(
  task: BrevynTask,
  refresh: AgentCourseTaskInfoRefresh,
): { summary: string; dueAt?: string; info: CourseTaskInfo } {
  const manualFields = courseTaskInfoManualFields(task).filter((field) => (
    field === "summary" ? Boolean(displayTaskSummary(task)) : Boolean(task.info?.deliverable?.trim())
  ));
  const preserveSummary = manualFields.includes("summary");
  const preserveDeliverable = manualFields.includes("deliverable");
  const deliverable = preserveDeliverable
    ? task.info?.deliverable
    : refresh.deliverable?.trim() || undefined;

  return {
    summary: preserveSummary ? task.summary : refresh.summary.trim(),
    dueAt: refresh.dueAt === undefined ? task.dueAt : refresh.dueAt,
    info: {
      deliverable,
      requirements: refresh.requirements,
      rubricCriteria: refresh.rubricCriteria,
      documents: refresh.documents,
      extractedAt: refresh.extractedAt,
      updatedBy: "agent",
      manualFields: manualFields.length > 0 ? manualFields : undefined,
    },
  };
}

export function courseTaskInfoManualFields(task: BrevynTask): CourseTaskInfoManualField[] {
  if (task.info?.manualFields) return uniqueManualFields(task.info.manualFields);
  if (task.info?.updatedBy !== "user") return [];

  const legacyFields: CourseTaskInfoManualField[] = [];
  if (displayTaskSummary(task)) legacyFields.push("summary");
  if (task.info.deliverable?.trim()) legacyFields.push("deliverable");
  return legacyFields;
}

export function manualFieldsAfterTaskInfoEdit(
  task: BrevynTask,
  nextSummary: string,
  nextDeliverable: string,
): CourseTaskInfoManualField[] {
  const fields = new Set(courseTaskInfoManualFields(task));
  const previousSummary = displayTaskSummary(task);
  const summary = nextSummary.trim();
  const previousDeliverable = task.info?.deliverable?.trim() || "";
  const deliverable = nextDeliverable.trim();

  if (summary !== previousSummary) updateManualField(fields, "summary", Boolean(summary));
  if (deliverable !== previousDeliverable) updateManualField(fields, "deliverable", Boolean(deliverable));
  return uniqueManualFields(Array.from(fields));
}

export function displayTaskSummary(task: BrevynTask): string {
  const summary = task.summary.trim();
  return summary === "Custom task created locally." ? "" : summary;
}

function updateManualField(
  fields: Set<CourseTaskInfoManualField>,
  field: CourseTaskInfoManualField,
  present: boolean,
): void {
  if (present) fields.add(field);
  else fields.delete(field);
}

function uniqueManualFields(fields: CourseTaskInfoManualField[]): CourseTaskInfoManualField[] {
  return Array.from(new Set(fields.filter((field) => field === "summary" || field === "deliverable")));
}

export function courseTaskInfoContent(
  info?: CourseTaskInfo,
): Pick<CourseTaskInfo, "deliverable" | "requirements" | "rubricCriteria" | "documents"> {
  return {
    deliverable: info?.deliverable,
    requirements: info?.requirements || [],
    rubricCriteria: info?.rubricCriteria || [],
    documents: info?.documents || [],
  };
}
