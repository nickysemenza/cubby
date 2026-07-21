import type { ProjectId } from "@cubby/schemas/identifiers";
import type { TaskOut, Trade } from "@cubby/schemas/project";
import { taskStatusValues, tradeValues } from "@cubby/schemas/project";
import { match } from "ts-pattern";
import type {
  BoardColumnKey,
  BoardLaneKey,
  TaskBoardPatch,
  TaskCardDragData,
} from "./board-types";

/**
 * Pure board layout + drag semantics — no React, no `~/` aliases, so it lives
 * under the vitest `unit` project (see `board-model.unit.test.ts`). Everything
 * derives from the task list: column/lane sets, per-cell card ordering, and the
 * patch a drop produces. es-toolkit is fine here; `@cubby/schemas` is fine here.
 */

export type BoardColsMode = "status" | "project" | "trade";
export type BoardLaneMode = "project" | "trade";

/** Body cap for the Done column — bounds the DOM; header still shows true count. */
export const DONE_COLUMN_CAP = 20;

/** Label for the null-project (unassigned) column/lane. */
export const INBOX_LABEL = "Inbox";

const NAMELESS_PROJECT = "Untitled project";

/** dueDate ascending with nulls last, then name — the derived card order. */
export function compareCards(a: TaskOut, b: TaskOut): number {
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate == null) return 1;
    if (b.dueDate == null) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  }
  return a.name.localeCompare(b.name);
}

/**
 * Project/trade axes derive from tasks with *active* (non-done) work — a
 * long-finished project shouldn't occupy a column/lane forever. Done tasks
 * still render in the status-mode Done column (capped), which owns history.
 */
function activeTasks(tasks: TaskOut[]): TaskOut[] {
  return tasks.filter((t) => t.status !== "done");
}

/** Projects with active tasks (by name), with Inbox (null) always first. */
function projectAxis(
  tasks: TaskOut[],
): { projectId: ProjectId | null; projectName: string }[] {
  const names = new Map<ProjectId, string>();
  for (const t of activeTasks(tasks)) {
    if (t.projectId != null) {
      names.set(t.projectId, t.projectName ?? NAMELESS_PROJECT);
    }
  }
  const present = [...names.entries()]
    .map(([projectId, projectName]) => ({ projectId, projectName }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
  return [{ projectId: null, projectName: INBOX_LABEL }, ...present];
}

/** Trades with active tasks, in canonical `tradeValues` order. */
function tradeAxis(tasks: TaskOut[]): Trade[] {
  const present = new Set<Trade>(activeTasks(tasks).map((t) => t.trade));
  return tradeValues.filter((tr) => present.has(tr));
}

/** The columns for a board mode. Status = all five always; project/trade = present. */
export function buildColumns(
  tasks: TaskOut[],
  cols: BoardColsMode,
): BoardColumnKey[] {
  return match(cols)
    .with("status", (): BoardColumnKey[] =>
      taskStatusValues.map((status) => ({ kind: "status", status })),
    )
    .with("project", (): BoardColumnKey[] =>
      projectAxis(tasks).map((p) => ({ kind: "project", ...p })),
    )
    .with("trade", (): BoardColumnKey[] =>
      tradeAxis(tasks).map((trade) => ({ kind: "trade", trade })),
    )
    .exhaustive();
}

/** The swimlane rows for a lane mode (present axis values only). */
export function buildLanes(
  tasks: TaskOut[],
  lane: BoardLaneMode,
): BoardLaneKey[] {
  return match(lane)
    .with("project", (): BoardLaneKey[] =>
      projectAxis(tasks).map((p) => ({ kind: "project", ...p })),
    )
    .with("trade", (): BoardLaneKey[] =>
      tradeAxis(tasks).map((trade) => ({ kind: "trade", trade })),
    )
    .exhaustive();
}

function matchesColumn(task: TaskOut, column: BoardColumnKey): boolean {
  return match(column)
    .with({ kind: "status" }, (c) => task.status === c.status)
    .with({ kind: "project" }, (c) => (task.projectId ?? null) === c.projectId)
    .with({ kind: "trade" }, (c) => task.trade === c.trade)
    .exhaustive();
}

function matchesLane(task: TaskOut, lane: BoardLaneKey): boolean {
  return match(lane)
    .with({ kind: "project" }, (l) => (task.projectId ?? null) === l.projectId)
    .with({ kind: "trade" }, (l) => task.trade === l.trade)
    .exhaustive();
}

/**
 * The cards for one cell (a column, optionally within a lane row), plus the
 * true count. Done work is bounded two ways: the status-mode Done column caps
 * its body at the {@link DONE_COLUMN_CAP} most recently-updated tasks, and
 * project/trade columns hide done tasks entirely (`hiddenDoneCount` reports
 * how many) — those modes are active-work triage boards, and a 200-card pile
 * of finished work would swamp them.
 */
export function cellTasks(
  tasks: TaskOut[],
  column: BoardColumnKey,
  lane: BoardLaneKey | null,
): { cards: TaskOut[]; totalCount: number; hiddenDoneCount: number } {
  const cell = tasks.filter(
    (t) => matchesColumn(t, column) && (lane == null || matchesLane(t, lane)),
  );
  const totalCount = cell.length;

  if (column.kind === "status") {
    if (column.status === "done") {
      const recent = [...cell]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, DONE_COLUMN_CAP);
      return { cards: recent, totalCount, hiddenDoneCount: 0 };
    }
    return {
      cards: [...cell].sort(compareCards),
      totalCount,
      hiddenDoneCount: 0,
    };
  }

  const active = cell.filter((t) => t.status !== "done");
  return {
    cards: active.sort(compareCards),
    totalCount,
    hiddenDoneCount: totalCount - active.length,
  };
}

function laneReassign(
  drag: TaskCardDragData,
  lane: BoardLaneKey,
): TaskBoardPatch {
  return match(lane)
    .with(
      { kind: "project" },
      (l): TaskBoardPatch =>
        l.projectId !== drag.projectId ? { projectId: l.projectId } : {},
    )
    .with(
      { kind: "trade" },
      (l): TaskBoardPatch => (l.trade !== drag.trade ? { trade: l.trade } : {}),
    )
    .exhaustive();
}

/**
 * The patch a drop produces, or null for a no-op (drop back onto the same
 * cell). A status-column drop writes `status`; if that cell sits in a differing
 * swimlane, the lane reassignment (`projectId`/`trade`) rides along. A
 * project/trade-column drop writes only that axis.
 */
export function computeMove(
  drag: TaskCardDragData,
  drop: { column: BoardColumnKey; lane: BoardLaneKey | null },
): TaskBoardPatch | null {
  const patch: TaskBoardPatch = match(drop.column)
    .with({ kind: "status" }, (col): TaskBoardPatch => {
      const p: TaskBoardPatch =
        col.status !== drag.status ? { status: col.status } : {};
      return drop.lane ? { ...p, ...laneReassign(drag, drop.lane) } : p;
    })
    .with(
      { kind: "project" },
      (col): TaskBoardPatch =>
        col.projectId !== drag.projectId ? { projectId: col.projectId } : {},
    )
    .with(
      { kind: "trade" },
      (col): TaskBoardPatch =>
        col.trade !== drag.trade ? { trade: col.trade } : {},
    )
    .exhaustive();

  return Object.keys(patch).length === 0 ? null : patch;
}
