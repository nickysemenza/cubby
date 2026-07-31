import { describe, expect, it } from "vitest";
import { buildEvents, buildResources, dateForDay } from "./CubbyGantt";
import type { GanttRow } from "./gantt-model";

const project: GanttRow = {
  kind: "project",
  id: "project-1",
  shortcode: "PROJ-0001",
  name: "Kitchen",
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
  shortcode: "TASK-0001",
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
});
