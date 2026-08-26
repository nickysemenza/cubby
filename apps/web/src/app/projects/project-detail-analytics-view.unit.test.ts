import { projectOut, taskOut } from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import {
  buildProjectAgendaGroups,
  formatProjectAgendaTaskDate,
} from "./project-detail-analytics-view";

const task = (name: string, dueDate: string | null, dueEndDate = dueDate) =>
  mock(taskOut, { overrides: { name, dueDate, dueEndDate } });

const project = (
  id: string,
  name: string,
  effectiveStart: string | null,
  effectiveEnd = effectiveStart,
) =>
  mock(projectOut, {
    overrides: { id, name, dates: { effectiveStart, effectiveEnd } },
  });

describe("buildProjectAgendaGroups", () => {
  it("interleaves dated tasks and sub-projects in chronological order", () => {
    const groups = buildProjectAgendaGroups(
      "PRJ-ABCD",
      [
        task("Later task", "2026-04-03"),
        task("Early task", "2026-04-01", "2026-04-04"),
      ],
      [
        project("PRJ-ABCD", "Root", "2026-04-01"),
        project("PRJ-EFGH", "Electrical", "2026-04-02", "2026-04-06"),
      ],
    );

    expect(groups.map((group) => group.day)).toEqual([
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
    ]);
    expect(groups[0]?.entries[0]).toMatchObject({
      kind: "task",
      task: { name: "Early task" },
    });
    expect(groups[1]?.entries[0]).toMatchObject({
      kind: "project",
      project: { name: "Electrical" },
    });
  });

  it("shows each ranged task only once at its start date", () => {
    const groups = buildProjectAgendaGroups(
      "PRJ-ABCD",
      [task("Three-day task", "2026-04-01", "2026-04-03")],
      [],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.day).toBe("2026-04-01");
  });

  it("schedules an end-only task at its end and labels that constraint", () => {
    const endOnly = task("Inspection deadline", null, "2026-04-08");
    const groups = buildProjectAgendaGroups("PRJ-ABCD", [endOnly], []);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.day).toBe("2026-04-08");
    expect(formatProjectAgendaTaskDate(endOnly)).toBe("Ends Apr 8");
  });

  it("omits the current project and undated records", () => {
    const groups = buildProjectAgendaGroups(
      "PRJ-ABCD",
      [task("No date", null)],
      [
        project("PRJ-ABCD", "Root", "2026-04-01"),
        project("PRJ-EFGH", "No date", null, null),
      ],
    );

    expect(groups).toEqual([]);
  });

  it("puts sub-projects before tasks that begin the same day", () => {
    const groups = buildProjectAgendaGroups(
      "PRJ-ABCD",
      [task("Finish wiring", "2026-04-01")],
      [project("PRJ-EFGH", "Electrical", "2026-04-01")],
    );

    expect(groups[0]?.entries.map((entry) => entry.kind)).toEqual([
      "project",
      "task",
    ]);
  });
});
