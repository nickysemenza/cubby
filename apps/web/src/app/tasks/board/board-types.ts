import type { ProjectId, TaskId } from "@cubby/schemas/identifiers";
import type { TaskStatus, Trade } from "@cubby/schemas/project";

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
