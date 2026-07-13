import assert from "node:assert/strict";
import {
  lectureWeekNumberFromPath,
  semesterWeekNumberForRange,
  semesterWeekRanges,
} from "./semester-weeks";

const offsetSemester = { startsAt: "2026-02-04", endsAt: "2026-02-18" };
assert.deepEqual(semesterWeekRanges(offsetSemester), [
  { weekNumber: 1, startsAt: "2026-02-04", endsAt: "2026-02-10" },
  { weekNumber: 2, startsAt: "2026-02-11", endsAt: "2026-02-17" },
  { weekNumber: 3, startsAt: "2026-02-18", endsAt: "2026-02-18" },
]);

assert.equal(
  semesterWeekNumberForRange(offsetSemester, "2026-02-09", "2026-02-15"),
  2,
  "A calendar week spanning two semester weeks should use its longest overlap.",
);

assert.ok(
  semesterWeekRanges({ startsAt: "2026-01-01", endsAt: "2026-08-31" }).length > 30,
  "Calendar week generation must not inherit the lecture upload display cap.",
);

assert.equal(lectureWeekNumberFromPath("Courses/Econ/Lecture/Week 3/notes.pdf"), 3);
assert.equal(lectureWeekNumberFromPath("Courses/Econ/Lecture/第 12 周/slides.pdf"), 12);
assert.equal(lectureWeekNumberFromPath("Courses/Econ/Course shared/notes.pdf"), undefined);

console.log("semester-weeks tests passed");
