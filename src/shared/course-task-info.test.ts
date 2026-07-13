import assert from "node:assert/strict";
import type { BrevynTask } from "../types/domain";
import {
  courseTaskInfoManualFields,
  manualFieldsAfterTaskInfoEdit,
  mergeAgentCourseTaskInfo,
} from "./course-task-info";

const baseTask: BrevynTask = {
  id: "task-1",
  semesterId: "semester-1",
  courseId: "course-1",
  title: "Essay",
  taskType: "Essay",
  status: "in_progress",
  dueAt: "2026-07-20T23:59:00+08:00",
  summary: "Agent summary",
  info: {
    deliverable: "Research essay",
    requirements: [],
    rubricCriteria: [],
    documents: [],
    extractedAt: "2026-07-10T00:00:00.000Z",
    updatedBy: "agent",
  },
};

assert.deepEqual(courseTaskInfoManualFields(baseTask), []);
assert.deepEqual(manualFieldsAfterTaskInfoEdit(baseTask, "My summary", "My paper"), ["summary", "deliverable"]);

const manuallyEdited: BrevynTask = {
  ...baseTask,
  summary: "My summary",
  info: {
    ...baseTask.info!,
    deliverable: "My paper",
    updatedBy: "user",
    manualFields: ["summary", "deliverable"],
  },
};
const protectedRefresh = mergeAgentCourseTaskInfo(manuallyEdited, {
  summary: "New agent summary",
  deliverable: "New agent deliverable",
  dueAt: "2026-07-22T23:59:00+08:00",
  requirements: [{ id: "requirement-1", category: "limit", text: "2,000 words" }],
  rubricCriteria: [],
  documents: [],
  extractedAt: "2026-07-12T00:00:00.000Z",
});
assert.equal(protectedRefresh.summary, "My summary");
assert.equal(protectedRefresh.info.deliverable, "My paper");
assert.equal(protectedRefresh.dueAt, "2026-07-22T23:59:00+08:00");
assert.deepEqual(protectedRefresh.info.manualFields, ["summary", "deliverable"]);

const releasedFields: BrevynTask = {
  ...manuallyEdited,
  summary: "",
  info: { ...manuallyEdited.info!, deliverable: undefined, manualFields: ["summary", "deliverable"] },
};
const releasedRefresh = mergeAgentCourseTaskInfo(releasedFields, {
  summary: "Fresh summary",
  deliverable: "Fresh deliverable",
  requirements: [],
  rubricCriteria: [],
  documents: [],
  extractedAt: "2026-07-12T00:00:00.000Z",
});
assert.equal(releasedRefresh.summary, "Fresh summary");
assert.equal(releasedRefresh.info.deliverable, "Fresh deliverable");
assert.equal(releasedRefresh.info.manualFields, undefined);

const legacyManual: BrevynTask = {
  ...baseTask,
  summary: "Legacy manual summary",
  info: { ...baseTask.info!, deliverable: "Legacy manual deliverable", updatedBy: "user" },
};
assert.deepEqual(courseTaskInfoManualFields(legacyManual), ["summary", "deliverable"]);

console.log("course-task-info tests passed");
