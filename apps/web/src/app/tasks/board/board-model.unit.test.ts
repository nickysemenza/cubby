import type { TaskOut } from "@cubby/schemas/project";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  buildColumns,
  buildLanes,
  cellTasks,
  compareCards,
  computeMove,
  computeRank,
  DONE_COLUMN_CAP,
  INBOX_LABEL,
} from "./board-model";
import type { TaskCardDragData } from "./board-types";

const taskId = (seed: string) => testShortcode("task", seed);

function task(params: {
  id: string;
  name?: string;
  status?: TaskOut["status"];
  projectId?: string | null;
  projectName?: string | null;
  trade?: TaskOut["trade"];
  dueDate?: string | null;
  sortOrder?: number | null;
  updatedAt?: Date;
}): TaskOut {
  return {
    id: testShortcode("task", params.id),
    name: params.name ?? params.id,
    status: params.status ?? "not_started",
    projectId:
      params.projectId != null
        ? testShortcode("project", params.projectId)
        : null,
    projectName: params.projectName ?? null,
    subjectProductId: null,
    subjectProductName: null,
    parentTaskId: null,
    parentTaskName: null,
    dueDate: params.dueDate ?? null,
    dueEndDate: null,
    trade: params.trade ?? "other",
    sortOrder: params.sortOrder ?? null,
    blockedByIds: [],
    blockingIds: [],
    subtaskCount: 0,
    doneSubtaskCount: 0,
    images: [],
    dataQuality: testCompleteDataQuality(),
    createdAt: new Date("2026-01-01"),
    updatedAt: params.updatedAt ?? new Date("2026-01-01"),
  };
}

function drag(t: TaskOut): TaskCardDragData {
  return {
    taskBoardDrag: true,
    taskId: t.id,
    status: t.status,
    projectId: t.projectId,
    trade: t.trade,
  };
}

describe("compareCards", () => {
  it("orders by dueDate ascending", () => {
    const a = task({ id: "a", dueDate: "2026-03-01" });
    const b = task({ id: "b", dueDate: "2026-01-01" });
    expect([a, b].sort(compareCards).map((t) => t.id)).toEqual([
      taskId("b"),
      taskId("a"),
    ]);
  });

  it("puts null dueDate last", () => {
    const a = task({ id: "a", dueDate: null });
    const b = task({ id: "b", dueDate: "2026-01-01" });
    expect([a, b].sort(compareCards).map((t) => t.id)).toEqual([
      taskId("b"),
      taskId("a"),
    ]);
  });

  it("breaks dueDate ties by name", () => {
    const a = task({ id: "a", name: "Zebra", dueDate: "2026-01-01" });
    const b = task({ id: "b", name: "Apple", dueDate: "2026-01-01" });
    expect([a, b].sort(compareCards).map((t) => t.id)).toEqual([
      taskId("b"),
      taskId("a"),
    ]);
  });

  it("puts a ranked card ahead of an unranked one, even with a later due date", () => {
    const ranked = task({ id: "a", dueDate: "2026-12-01", sortOrder: 1024 });
    const unranked = task({ id: "b", dueDate: "2026-01-01" });
    expect([unranked, ranked].sort(compareCards).map((t) => t.id)).toEqual([
      taskId("a"),
      taskId("b"),
    ]);
  });

  it("orders two ranked cards by ascending sortOrder", () => {
    const a = task({ id: "a", sortOrder: 2048 });
    const b = task({ id: "b", sortOrder: 1024 });
    expect([a, b].sort(compareCards).map((t) => t.id)).toEqual([
      taskId("b"),
      taskId("a"),
    ]);
  });
});

describe("computeRank", () => {
  const ordered = (
    specs: { id: string; sortOrder?: number | null }[],
  ): TaskOut[] => specs.map((s) => task({ id: s.id, sortOrder: s.sortOrder }));

  it("midpoints between two ranked neighbors", () => {
    const cards = ordered([
      { id: "r1", sortOrder: 1024 },
      { id: "d", sortOrder: null },
      { id: "r2", sortOrder: 2048 },
    ]);
    expect(computeRank(cards, 1)).toEqual({ kind: "single", sortOrder: 1536 });
  });

  it("materializes the whole cell when the gap between ranks is degenerate", () => {
    const cards = ordered([
      { id: "r1", sortOrder: 1024 },
      { id: "d", sortOrder: null },
      { id: "r2", sortOrder: 1024 },
    ]);
    expect(computeRank(cards, 1)).toEqual({
      kind: "materialize",
      ranks: [
        { id: taskId("r1"), sortOrder: 1024 },
        { id: taskId("d"), sortOrder: 2048 },
        { id: taskId("r2"), sortOrder: 3072 },
      ],
    });
  });

  it("appends after the last ranked card (before ranked only)", () => {
    const cards = ordered([
      { id: "r1", sortOrder: 1024 },
      { id: "d", sortOrder: null },
      { id: "u", sortOrder: null },
    ]);
    expect(computeRank(cards, 1)).toEqual({ kind: "single", sortOrder: 2048 });
  });

  it("inserts above the top ranked card (after ranked only)", () => {
    const cards = ordered([
      { id: "d", sortOrder: null },
      { id: "r1", sortOrder: 1024 },
    ]);
    expect(computeRank(cards, 0)).toEqual({ kind: "single", sortOrder: 0 });
  });

  it("materializes the prefix through the insert point in the unranked tail", () => {
    const cards = ordered([
      { id: "u1", sortOrder: null },
      { id: "d", sortOrder: null },
      { id: "u2", sortOrder: null },
    ]);
    expect(computeRank(cards, 1)).toEqual({
      kind: "materialize",
      ranks: [
        { id: taskId("u1"), sortOrder: 1024 },
        { id: taskId("d"), sortOrder: 2048 },
      ],
    });
  });
});

describe("buildColumns", () => {
  it("status mode always returns all five statuses in canonical order", () => {
    const cols = buildColumns([task({ id: "a", status: "done" })], "status");
    expect(cols).toEqual([
      { kind: "status", status: "not_started" },
      { kind: "status", status: "later" },
      { kind: "status", status: "in_progress" },
      { kind: "status", status: "blocked" },
      { kind: "status", status: "done" },
    ]);
  });

  it("project mode leads with Inbox then present projects by name", () => {
    const tasks = [
      task({ id: "a", projectId: "p2", projectName: "Bathroom" }),
      task({ id: "b", projectId: "p1", projectName: "Attic" }),
      task({ id: "c", projectId: null }),
    ];
    const cols = buildColumns(tasks, "project");
    expect(
      cols.map((c) => (c.kind === "project" ? c.projectName : "")),
    ).toEqual([INBOX_LABEL, "Attic", "Bathroom"]);
  });

  it("project mode omits projects whose only tasks are done", () => {
    const tasks = [
      task({ id: "a", projectId: "p1", projectName: "Attic" }),
      task({
        id: "b",
        projectId: "p2",
        projectName: "Finished reno",
        status: "done",
      }),
    ];
    const cols = buildColumns(tasks, "project");
    expect(
      cols.map((c) => (c.kind === "project" ? c.projectName : "")),
    ).toEqual([INBOX_LABEL, "Attic"]);
  });

  it("trade mode returns present trades in tradeValues order", () => {
    const tasks = [
      task({ id: "a", trade: "plumbing" }),
      task({ id: "b", trade: "demolition" }),
    ];
    const cols = buildColumns(tasks, "trade");
    expect(cols).toEqual([
      { kind: "trade", trade: "demolition" },
      { kind: "trade", trade: "plumbing" },
    ]);
  });
});

describe("buildLanes", () => {
  it("project lanes lead with Inbox then present projects", () => {
    const lanes = buildLanes(
      [task({ id: "a", projectId: "p1", projectName: "Attic" })],
      "project",
    );
    expect(
      lanes.map((l) => (l.kind === "project" ? l.projectName : "")),
    ).toEqual([INBOX_LABEL, "Attic"]);
  });
});

describe("cellTasks", () => {
  it("filters by column and lane and sorts by compareCards", () => {
    const tasks = [
      task({ id: "a", status: "not_started", dueDate: "2026-02-01" }),
      task({ id: "b", status: "not_started", dueDate: "2026-01-01" }),
      task({ id: "c", status: "done", dueDate: "2026-01-01" }),
    ];
    const { cards, totalCount } = cellTasks(
      tasks,
      { kind: "status", status: "not_started" },
      null,
    );
    expect(cards.map((t) => t.id)).toEqual([taskId("b"), taskId("a")]);
    expect(totalCount).toBe(2);
  });

  it("caps the Done column at the most-recently-updated tasks with true count", () => {
    const tasks = Array.from({ length: DONE_COLUMN_CAP + 5 }, (_, i) =>
      task({
        id: `d${i}`,
        status: "done",
        updatedAt: new Date(2026, 0, 1, 0, i),
      }),
    );
    const { cards, totalCount } = cellTasks(
      tasks,
      { kind: "status", status: "done" },
      null,
    );
    expect(totalCount).toBe(DONE_COLUMN_CAP + 5);
    expect(cards).toHaveLength(DONE_COLUMN_CAP);
    expect(cards[0]?.id).toBe(taskId(`d${DONE_COLUMN_CAP + 4}`));
  });

  it("hides done tasks in project columns and reports the hidden count", () => {
    const tasks = [
      task({ id: "a", projectId: "p1", projectName: "Attic" }),
      task({ id: "b", projectId: "p1", projectName: "Attic", status: "done" }),
      task({ id: "c", projectId: "p1", projectName: "Attic", status: "done" }),
    ];
    const { cards, totalCount, hiddenDoneCount } = cellTasks(
      tasks,
      {
        kind: "project",
        projectId: testShortcode("project", "p1"),
        projectName: "Attic",
      },
      null,
    );
    expect(cards.map((t) => t.id)).toEqual([taskId("a")]);
    expect(totalCount).toBe(3);
    expect(hiddenDoneCount).toBe(2);
  });

  it("ignores sortOrder in the Done column — it stays recency-ordered", () => {
    // A stale sortOrder must not reorder Done (it sorts by updatedAt desc).
    const tasks = [
      task({
        id: "old",
        status: "done",
        sortOrder: 1024,
        updatedAt: new Date(2026, 0, 1),
      }),
      task({
        id: "recent",
        status: "done",
        sortOrder: 9999,
        updatedAt: new Date(2026, 0, 2),
      }),
    ];
    const { cards } = cellTasks(
      tasks,
      { kind: "status", status: "done" },
      null,
    );
    expect(cards.map((t) => t.id)).toEqual([taskId("recent"), taskId("old")]);
  });

  it("orders a non-done cell by sortOrder ahead of the derived order", () => {
    const tasks = [
      task({ id: "a", status: "not_started", dueDate: "2026-01-01" }),
      task({
        id: "b",
        status: "not_started",
        dueDate: "2026-12-01",
        sortOrder: 1024,
      }),
    ];
    const { cards } = cellTasks(
      tasks,
      { kind: "status", status: "not_started" },
      null,
    );
    expect(cards.map((t) => t.id)).toEqual([taskId("b"), taskId("a")]);
  });

  it("respects the lane when filtering", () => {
    const tasks = [
      task({ id: "a", status: "not_started", projectId: "p1" }),
      task({ id: "b", status: "not_started", projectId: null }),
    ];
    const inbox = cellTasks(
      tasks,
      { kind: "status", status: "not_started" },
      { kind: "project", projectId: null, projectName: INBOX_LABEL },
    );
    expect(inbox.cards.map((t) => t.id)).toEqual([taskId("b")]);
  });
});

describe("computeMove", () => {
  const t = task({
    id: "a",
    status: "not_started",
    projectId: "p1",
    trade: "plumbing",
  });

  it("writes status on a status-column drop", () => {
    expect(
      computeMove(drag(t), {
        column: { kind: "status", status: "in_progress" },
        lane: null,
      }),
    ).toEqual({ status: "in_progress" });
  });

  it("returns null for a no-op drop back onto the same status", () => {
    expect(
      computeMove(drag(t), {
        column: { kind: "status", status: "not_started" },
        lane: null,
      }),
    ).toBeNull();
  });

  it("writes status + projectId when dropping into a differing project lane", () => {
    expect(
      computeMove(drag(t), {
        column: { kind: "status", status: "in_progress" },
        lane: {
          kind: "project",
          projectId: testShortcode("project", "p2"),
          projectName: "B",
        },
      }),
    ).toEqual({
      status: "in_progress",
      projectId: testShortcode("project", "p2"),
    });
  });

  it("un-assigns the project when dropping into the Inbox lane", () => {
    expect(
      computeMove(drag(t), {
        column: { kind: "status", status: "not_started" },
        lane: { kind: "project", projectId: null, projectName: INBOX_LABEL },
      }),
    ).toEqual({ projectId: null });
  });

  it("writes only projectId on a project-column drop", () => {
    expect(
      computeMove(drag(t), {
        column: {
          kind: "project",
          projectId: testShortcode("project", "p2"),
          projectName: "B",
        },
        lane: null,
      }),
    ).toEqual({ projectId: testShortcode("project", "p2") });
  });

  it("writes only trade on a trade-column drop", () => {
    expect(
      computeMove(drag(t), {
        column: { kind: "trade", trade: "electrical" },
        lane: null,
      }),
    ).toEqual({ trade: "electrical" });
  });

  it("returns null when a project-column drop lands on the current project", () => {
    expect(
      computeMove(drag(t), {
        column: {
          kind: "project",
          projectId: testShortcode("project", "p1"),
          projectName: "A",
        },
        lane: null,
      }),
    ).toBeNull();
  });

  it("folds sortOrder into a cross-cell status drop", () => {
    expect(
      computeMove(
        drag(t),
        { column: { kind: "status", status: "in_progress" }, lane: null },
        5120,
      ),
    ).toEqual({ status: "in_progress", sortOrder: 5120 });
  });

  it("is never null when sortOrder is supplied — a pure in-cell reprioritize is a change", () => {
    expect(
      computeMove(
        drag(t),
        { column: { kind: "status", status: "not_started" }, lane: null },
        3072,
      ),
    ).toEqual({ sortOrder: 3072 });
  });
});
