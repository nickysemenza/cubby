import type { ProjectId, TaskId } from "@cubby/schemas/identifiers";
import type { TaskStatus, Trade } from "@cubby/schemas/project";
import { match } from "ts-pattern";

/**
 * pragmatic-drag-and-drop payloads for the task board. A card is the drag
 * source; a cell (a column, optionally inside a swimlane row) is the drop
 * target. Data rides the wire as `Record<string | symbol, unknown>`; the
 * `as*` guards below narrow it back. Mirrors `locations/arrange/arrange-types`.
 */

/** The moved task's current coordinates — lets the drop handler diff for no-ops. */
export type TaskCardDragData = {
  taskBoardDrag: true;
  taskId: TaskId;
  status: TaskStatus;
  projectId: ProjectId | null;
  trade: Trade;
};

/**
 * A board axis value. Columns and swimlanes are the same three kinds; the
 * `kind` discriminant drives the ts-pattern `match` in the drop handler.
 * `project` with `projectId: null` is the "Inbox" (unassigned) axis value.
 */
export type BoardColumnKey =
  | { kind: "status"; status: TaskStatus }
  | { kind: "project"; projectId: ProjectId | null; projectName: string }
  | { kind: "trade"; trade: Trade };

/** A swimlane row key — project or trade only (status is never a lane). */
export type BoardLaneKey =
  | { kind: "project"; projectId: ProjectId | null; projectName: string }
  | { kind: "trade"; trade: Trade };

/** A cell drop target: its column, plus the lane row it sits in (null = no lanes). */
export type BoardDropData = {
  taskBoardTarget: true;
  column: BoardColumnKey;
  lane: BoardLaneKey | null;
};

/** The fields a single drop can write — a subset of `taskUpdateData`. */
export type TaskBoardPatch = {
  status?: TaskStatus;
  projectId?: ProjectId | null;
  trade?: Trade;
};

/**
 * Fields a board quick-add can pre-fill on `CreateTaskDialog` — derived from
 * whichever column (and, when swimlanes are on, lane) the "+" was clicked
 * from, so the created task lands directly in that cell.
 */
export type TaskCreatePreset = {
  status?: TaskStatus;
  projectId?: ProjectId | null;
  trade?: Trade;
};

function presetForAxis(key: BoardColumnKey | BoardLaneKey): TaskCreatePreset {
  return match(key)
    .with({ kind: "status" }, (k) => ({ status: k.status }))
    .with({ kind: "project" }, (k) => ({ projectId: k.projectId }))
    .with({ kind: "trade" }, (k) => ({ trade: k.trade }))
    .exhaustive();
}

/**
 * The quick-add preset for a cell — the column's axis alone, or merged with
 * the lane's axis when swimlanes are on (only then does the cell know both).
 */
export function taskCreatePreset(
  column: BoardColumnKey,
  lane: BoardLaneKey | null,
): TaskCreatePreset {
  return lane
    ? { ...presetForAxis(column), ...presetForAxis(lane) }
    : presetForAxis(column);
}

/** The Done status column skips quick-add — creating a pre-finished task makes no sense. */
export function isQuickAddEligible(column: BoardColumnKey): boolean {
  return !(column.kind === "status" && column.status === "done");
}

export function asDragData(
  data: Record<string | symbol, unknown>,
): TaskCardDragData | null {
  return data.taskBoardDrag === true ? (data as TaskCardDragData) : null;
}

export function asDropData(
  data: Record<string | symbol, unknown>,
): BoardDropData | null {
  return data.taskBoardTarget === true ? (data as BoardDropData) : null;
}
