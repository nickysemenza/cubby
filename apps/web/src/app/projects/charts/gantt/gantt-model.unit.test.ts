import type { ProjectOut, TaskOut } from "@cubby/schemas/project";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { toDayIndex } from "./gantt-date";
import {
  buildPortfolioRows,
  buildProjectRows,
  type GanttProjectRow,
  type GanttRow,
} from "./gantt-model";

const projectId = (seed: string) => testShortcode("project", seed);
const taskId = (seed: string) => testShortcode("task", seed);

/** Readable fixture labels are converted to deterministic schema-valid
 * shortcodes while names remain readable in assertions. */
function project(params: {
  id: string;
  parentProjectId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  kind?: ProjectOut["kind"];
  status?: ProjectOut["status"];
  icon?: string | null;
  taskCount?: number;
  doneTaskCount?: number;
  subtreeTaskCount?: number;
  subtreeDoneTaskCount?: number;
}): ProjectOut {
  const taskCount = params.taskCount ?? 0;
  const doneTaskCount = params.doneTaskCount ?? 0;
  return {
    id: testShortcode("project", params.id),
    name: params.id,
    status: params.status ?? "planning",
    kind: params.kind ?? null,
    locations: [],
    defaultTrade: null,
    costEstimate: null,
    parentProjectId:
      params.parentProjectId != null
        ? testShortcode("project", params.parentProjectId)
        : null,
    startDate: params.startDate ?? null,
    endDate: params.endDate ?? null,
    icon: params.icon ?? null,
    notes: null,
    googleDriveFolderUrl: null,
    notionPageUrl: null,
    dates: {
      derivedStart: params.startDate ?? null,
      derivedEnd: params.endDate ?? null,
      effectiveStart: params.startDate ?? null,
      effectiveEnd: params.endDate ?? null,
      startSource: params.startDate != null ? "explicit" : "none",
      endSource: params.endDate != null ? "explicit" : "none",
    },
    parentProjectName: null,
    childProjectIds: [],
    blockedByIds: [],
    blockingIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    rollup: {
      spent: 0,
      actualSpent: 0,
      committedSpent: 0,
      contributions: 0,
      expenseCount: 0,
      taskCount,
      doneTaskCount,
      subtree: {
        spent: 0,
        actualSpent: 0,
        committedSpent: 0,
        contributions: 0,
        expenseCount: 0,
        taskCount: params.subtreeTaskCount ?? taskCount,
        doneTaskCount: params.subtreeDoneTaskCount ?? doneTaskCount,
        projectCount: 0,
        costEstimate: null,
      },
    },
    dataQuality: testCompleteDataQuality(),
  };
}

function task(params: {
  id: string;
  projectId?: string | null;
  parentTaskId?: string | null;
  dueDate?: string | null;
  dueEndDate?: string | null;
  status?: TaskOut["status"];
}): TaskOut {
  return {
    id: testShortcode("task", params.id),
    name: params.id,
    status: params.status ?? "not_started",
    projectId:
      params.projectId != null
        ? testShortcode("project", params.projectId)
        : null,
    parentTaskId:
      params.parentTaskId != null
        ? testShortcode("task", params.parentTaskId)
        : null,
    dueDate: params.dueDate ?? null,
    dueEndDate: params.dueEndDate ?? null,
    trade: "other",
    sortOrder: null,
    projectName: null,
    subjectProductId: null,
    subjectProductName: null,
    parentTaskName: null,
    blockedByIds: [],
    blockingIds: [],
    subtaskCount: 0,
    doneSubtaskCount: 0,
    images: [],
    dataQuality: testCompleteDataQuality(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function projectRowsOf(rows: GanttRow[]): GanttProjectRow[] {
  return rows.filter((r): r is GanttProjectRow => r.kind === "project");
}

describe("buildPortfolioRows", () => {
  it("carries custom project icons into visualization rows", () => {
    const { rows } = buildPortfolioRows(
      [project({ id: "garage", icon: "🔧" })],
      new Set(),
    );

    expect(projectRowsOf(rows)[0]?.icon).toBe("🔧");
  });

  it("walks a 3-level project tree with correct depths when fully expanded", () => {
    const root = project({ id: "root" });
    const child = project({ id: "child", parentProjectId: "root" });
    const grandchild = project({ id: "grandchild", parentProjectId: "child" });
    const { rows } = buildPortfolioRows(
      [root, child, grandchild],
      new Set([projectId("root"), projectId("child")]),
    );
    const projects = projectRowsOf(rows);
    expect(projects.map((p) => [p.id, p.depth])).toEqual([
      [projectId("root"), 0],
      [projectId("child"), 1],
      [projectId("grandchild"), 2],
    ]);
  });

  it("hides children of a collapsed node", () => {
    const root = project({ id: "root" });
    const child = project({ id: "child", parentProjectId: "root" });
    const { rows } = buildPortfolioRows([root, child], new Set());
    const projects = projectRowsOf(rows);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.expandable).toBe(true);
    expect(projects[0]?.expanded).toBe(false);
  });

  it("promotes an orphaned child to root when its parent is filtered out", () => {
    const orphan = project({ id: "orphan", parentProjectId: "missing-parent" });
    const { rows } = buildPortfolioRows([orphan], new Set());
    const projects = projectRowsOf(rows);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.id).toBe(projectId("orphan"));
    expect(projects[0]?.depth).toBe(0);
  });

  it("marks a project with a start but no end date as open-ended", () => {
    const p = project({ id: "p", startDate: "2026-01-01" });
    const { rows } = buildPortfolioRows([p], new Set());
    const row = projectRowsOf(rows)[0];
    expect(row?.openEnded).toBe(true);
    expect(row?.endDay).toBeNull();
    expect(row?.startDay).toBe(toDayIndex("2026-01-01"));
  });

  it("does not emit a right-side envelope on an open-ended parent whose child ends later", () => {
    const parent = project({ id: "parent", startDate: "2026-01-10" });
    const child = project({
      id: "child",
      parentProjectId: "parent",
      startDate: "2026-01-15",
      endDate: "2026-06-01",
    });
    const { rows } = buildPortfolioRows(
      [parent, child],
      new Set([projectId("parent")]),
    );
    const parentRow = projectRowsOf(rows).find(
      (r) => r.id === projectId("parent"),
    );
    expect(parentRow?.openEnded).toBe(true);
    expect(parentRow?.envelope).toBeNull();
  });

  it("still emits a left-side envelope on an open-ended parent whose child starts earlier", () => {
    const parent = project({ id: "parent", startDate: "2026-01-10" });
    const child = project({
      id: "child",
      parentProjectId: "parent",
      startDate: "2025-11-01",
      endDate: "2026-02-01",
    });
    const { rows } = buildPortfolioRows(
      [parent, child],
      new Set([projectId("parent")]),
    );
    const parentRow = projectRowsOf(rows).find(
      (r) => r.id === projectId("parent"),
    );
    expect(parentRow?.envelope).toEqual({
      startDay: toDayIndex("2025-11-01"),
      endDay: toDayIndex("2026-01-10"),
    });
  });

  it("emits an envelope when a descendant's dates extend beyond the node's own bar", () => {
    const parent = project({
      id: "parent",
      startDate: "2026-01-10",
      endDate: "2026-01-20",
    });
    const child = project({
      id: "child",
      parentProjectId: "parent",
      startDate: "2026-01-05",
      endDate: "2026-01-25",
    });
    const { rows } = buildPortfolioRows(
      [parent, child],
      new Set([projectId("parent")]),
    );
    const parentRow = projectRowsOf(rows).find(
      (r) => r.id === projectId("parent"),
    );
    expect(parentRow?.envelope).toEqual({
      startDay: toDayIndex("2026-01-05"),
      endDay: toDayIndex("2026-01-25"),
    });
  });

  it("emits no envelope when the descendant's dates are contained by the node's own bar", () => {
    const parent = project({
      id: "parent",
      startDate: "2026-01-01",
      endDate: "2026-01-30",
    });
    const child = project({
      id: "child",
      parentProjectId: "parent",
      startDate: "2026-01-10",
      endDate: "2026-01-20",
    });
    const { rows } = buildPortfolioRows(
      [parent, child],
      new Set([projectId("parent")]),
    );
    const parentRow = projectRowsOf(rows).find(
      (r) => r.id === projectId("parent"),
    );
    expect(parentRow?.envelope).toBeNull();
  });

  it("still emits an envelope for an undated node whose descendants are dated", () => {
    const parent = project({ id: "parent" });
    const child = project({
      id: "child",
      parentProjectId: "parent",
      startDate: "2026-02-01",
      endDate: "2026-02-05",
    });
    const { rows } = buildPortfolioRows(
      [parent, child],
      new Set([projectId("parent")]),
    );
    const parentRow = projectRowsOf(rows).find(
      (r) => r.id === projectId("parent"),
    );
    expect(parentRow?.envelope).toEqual({
      startDay: toDayIndex("2026-02-01"),
      endDay: toDayIndex("2026-02-05"),
    });
  });

  it("treats a fully-undated subtree as unscheduled", () => {
    const parent = project({ id: "parent" });
    const child = project({ id: "child", parentProjectId: "parent" });
    const { unscheduled, extent } = buildPortfolioRows(
      [parent, child],
      new Set([projectId("parent")]),
    );
    expect(unscheduled.map((p) => p.id)).toEqual([projectId("parent")]);
    expect(extent).toBeNull();
  });

  it("uses the subtree rollup for progress when a node has children, own rollup for a leaf", () => {
    const parent = project({
      id: "parent",
      taskCount: 2,
      doneTaskCount: 1, // own: 0.5
      subtreeTaskCount: 10,
      subtreeDoneTaskCount: 5, // subtree: 0.5 too, but distinguishable via count below
    });
    const leaf = project({ id: "leaf", taskCount: 4, doneTaskCount: 3 }); // 0.75
    const { rows } = buildPortfolioRows([parent, leaf], new Set());
    const parentRow = projectRowsOf(rows).find(
      (r) => r.id === projectId("parent"),
    );
    const leafRow = projectRowsOf(rows).find((r) => r.id === projectId("leaf"));
    expect(parentRow?.progress).toBeCloseTo(0.5);
    expect(leafRow?.progress).toBeCloseTo(0.75);
  });

  it("computes extent and activeExtent, excluding done projects from activeExtent", () => {
    const active = project({
      id: "active",
      startDate: "2026-01-01",
      endDate: "2026-01-10",
      status: "in_progress",
    });
    const finished = project({
      id: "finished",
      startDate: "2025-01-01",
      endDate: "2025-01-10",
      status: "done",
    });
    const { extent, activeExtent } = buildPortfolioRows(
      [active, finished],
      new Set(),
    );
    expect(extent).toEqual({
      startDay: toDayIndex("2025-01-01"),
      endDay: toDayIndex("2026-01-10"),
    });
    expect(activeExtent).toEqual({
      startDay: toDayIndex("2026-01-01"),
      endDay: toDayIndex("2026-01-10"),
    });
  });

  it("groups roots by kind, in enum-declared order, only kinds present, with an Other group last", () => {
    const garden = project({ id: "garden-1", kind: "garden" });
    const furniture = project({ id: "furniture-1", kind: "furniture" });
    const noKind = project({ id: "no-kind" });
    const { rows } = buildPortfolioRows(
      [garden, furniture, noKind],
      new Set(),
      {
        groupBy: "kind",
      },
    );
    const groupRows = rows.filter((r) => r.kind === "group");
    expect(groupRows.map((g) => (g.kind === "group" ? g.label : null))).toEqual(
      ["Furniture", "Garden", "Other"],
    );
    const kindOrder = rows.map((r) =>
      r.kind === "group" ? `group:${r.label}` : r.id,
    );
    expect(kindOrder).toEqual([
      "group:Furniture",
      projectId("furniture-1"),
      "group:Garden",
      projectId("garden-1"),
      "group:Other",
      projectId("no-kind"),
    ]);
  });
});

describe("buildProjectRows", () => {
  it("renders the root's own tasks at depth 0 and a sub-project's tasks nested when expanded", () => {
    const subA = project({ id: "subA", parentProjectId: "root" });
    const rootTask = task({
      id: "t-root",
      projectId: "root",
      dueDate: "2026-03-01",
    });
    const subTask = task({
      id: "t-sub",
      projectId: "subA",
      dueDate: "2026-03-05",
    });
    const subSubtask = task({
      id: "t-sub-sub",
      projectId: "subA",
      parentTaskId: "t-sub",
      dueDate: "2026-03-06",
    });
    const undated = task({ id: "t-undated", projectId: "root" });

    const { rows, unscheduled } = buildProjectRows(
      projectId("root"),
      [subA],
      [rootTask, subTask, subSubtask, undated],
      new Set([projectId("subA")]),
    );

    expect(
      rows.map((r) =>
        r.kind === "group" ? [r.kind, r.id, null] : [r.kind, r.id, r.depth],
      ),
    ).toEqual([
      ["task", taskId("t-root"), 0],
      ["project", projectId("subA"), 0],
      ["task", taskId("t-sub"), 1],
      ["task", taskId("t-sub-sub"), 2],
    ]);
    expect(unscheduled.map((t) => t.id)).toEqual([taskId("t-undated")]);
  });

  it("hides a sub-project's tasks when it is collapsed, but still marks it expandable", () => {
    const subA = project({ id: "subA", parentProjectId: "root" });
    const subTask = task({
      id: "t-sub",
      projectId: "subA",
      dueDate: "2026-03-05",
    });
    const { rows } = buildProjectRows(
      projectId("root"),
      [subA],
      [subTask],
      new Set(),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "project",
        id: projectId("subA"),
        expandable: true,
        expanded: false,
      }),
    ]);
  });

  it("treats a task whose declared parent isn't in the task list as a normal top-level task", () => {
    const rootTask = task({
      id: "t-root",
      projectId: "root",
      parentTaskId: "missing-parent-task",
      dueDate: "2026-03-01",
    });
    const { rows } = buildProjectRows(
      projectId("root"),
      [],
      [rootTask],
      new Set(),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "task",
        id: taskId("t-root"),
        depth: 0,
      }),
    ]);
  });

  it("computes extent across both sub-project and task dates", () => {
    const subA = project({
      id: "subA",
      parentProjectId: "root",
      startDate: "2026-01-01",
      endDate: "2026-01-05",
    });
    const t = task({
      id: "t",
      projectId: "root",
      dueDate: "2026-06-01",
      dueEndDate: "2026-06-10",
    });
    const { extent } = buildProjectRows("root", [subA], [t], new Set());
    expect(extent).toEqual({
      startDay: toDayIndex("2026-01-01"),
      endDay: toDayIndex("2026-06-10"),
    });
  });

  // These walks run in the browser, so a cyclic parent chain must degrade to a
  // finite result rather than blowing the stack and taking the page with it.
  // The DB's create/update cycle guard means this should be unreachable —
  // it's the same defence the server keeps in repo/project/subtree.ts.
  it("terminates on a cyclic parent chain instead of overflowing the stack", () => {
    const a = project({
      id: "a",
      parentProjectId: "b",
      startDate: "2026-01-01",
    });
    const b = project({ id: "b", parentProjectId: "a", endDate: "2026-03-01" });

    const result = buildPortfolioRows(
      [a, b],
      new Set([projectId("a"), projectId("b")]),
    );

    expect(result.rows).toEqual([]);
    expect(result.extent).toEqual({
      startDay: toDayIndex("2026-01-01"),
      endDay: toDayIndex("2026-03-01"),
    });
  });
});
