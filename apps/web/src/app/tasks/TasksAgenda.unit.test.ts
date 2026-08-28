import { taskOut } from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import { groupTasksByDueDate } from "./TasksAgenda";

const task = (name: string, dueDate: string | null, dueEndDate = dueDate) =>
  mock(taskOut, { overrides: { name, dueDate, dueEndDate } });

describe("groupTasksByDueDate", () => {
  it("groups by dueDate in date order", () => {
    const groups = groupTasksByDueDate([
      task("late", "2026-03-03", null),
      task("early", "2026-03-01", null),
    ]);
    expect(groups.map((g) => g.day)).toEqual(["2026-03-01", "2026-03-03"]);
  });

  it("omits undated tasks entirely", () => {
    const groups = groupTasksByDueDate([
      task("dated", "2026-03-01", null),
      task("undated", null, null),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.tasks.map((t) => t.name)).toEqual(["dated"]);
  });

  it("puts a ranged task under its START day only, never repeated across the range", () => {
    // Unlike the calendar's day-by-day repeat, a 3-day task appears once —
    // TaskCard already prints the whole dueDate → dueEndDate range inline.
    const groups = groupTasksByDueDate([
      task("ranged", "2026-03-01", "2026-03-04"),
    ]);
    expect(groups.map((g) => g.day)).toEqual(["2026-03-01"]);
  });

  it("sorts same-day tasks by name", () => {
    const groups = groupTasksByDueDate([
      task("zebra", "2026-03-01", null),
      task("alpha", "2026-03-01", null),
    ]);
    expect(groups[0]?.tasks.map((t) => t.name)).toEqual(["alpha", "zebra"]);
  });
});
