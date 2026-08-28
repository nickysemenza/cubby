import { describe, expect, it } from "vitest";

import {
  buildEvents,
  buildResources,
  dateForDay,
  dependencyDisclosureFor,
} from "./CubbyGantt";
import type { GanttRow } from "./gantt-model";

const project: GanttRow = {
  kind: "project",
  id: "project-1",
  name: "Kitchen",
  icon: "🔨",
  depth: 0,
  expandable: true,
  expanded: true,
  status: "in_progress",
  startDay: 20_000,
  endDay: 20_010,
  openEnded: false,
  envelope: null,
  progress: 0.5,
  blockedByIds: [],
  blockingIds: [],
  childCount: 1,
  trade: "building",
};

const task: GanttRow = {
  kind: "task",
  id: "task-1",
  name: "Install cabinets",
  depth: 1,
  status: "not_started",
  startDay: 20_002,
  endDay: 20_002,
  trade: "cabinetry",
  blockedByIds: [],
  blockingIds: [],
};

describe("CubbyGantt adapters", () => {
  it("turns flattened Cubby rows into a nested resource tree", () => {
    expect(buildResources([project, task])).toMatchObject([
      {
        id: "project-1",
        children: [{ id: "task-1" }],
      },
    ]);
  });

  it("uses exclusive event ends and identifies milestones", () => {
    const events = buildEvents([project, task], 20_020, new Set(["task-1"]));
    const taskEvent = events.find((event) => event.data?.rowId === "task-1");

    expect(taskEvent?.data).toMatchObject({
      critical: true,
      milestone: true,
    });
    expect(taskEvent?.end.getTime()).toBe(dateForDay(20_003).getTime());
  });

  it("resolves a selected row's predecessors and successors by name", () => {
    const dependent: GanttRow = {
      ...task,
      id: "task-2",
      name: "Fit doors",
      blockedByIds: ["task-1", "missing-task"],
      blockingIds: ["project-1"],
    };
    const disclosure = dependencyDisclosureFor(
      dependent,
      new Map<string, GanttRow>([
        [project.id, project] as const,
        [task.id, task] as const,
        [dependent.id, dependent] as const,
      ]),
    );

    expect(disclosure).toMatchObject({
      row: { name: "Fit doors" },
      blockedBy: [{ name: "Install cabinets" }],
      blocking: [{ name: "Kitchen" }],
      missingBlockedByCount: 1,
      missingBlockingCount: 0,
    });
  });

  it("does not invent a dependency disclosure for a row without links", () => {
    expect(
      dependencyDisclosureFor(task, new Map([[task.id, task]])),
    ).toBeNull();
  });
});
