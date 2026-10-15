import {
  type ProjectShortcode,
  projectShortcode,
  taskShortcode,
} from "@cubby/schemas/identifiers";
import {
  type TaskStatus,
  type Trade,
  taskStatusSchema,
  tradeSchema,
} from "@cubby/schemas/project";
import type { Data } from "@dnd-kit/core";
import { match } from "ts-pattern";
import { z } from "zod";

/**
 * dnd-kit payloads for the task board. A card is the drag source; a cell (a
 * column, optionally inside a swimlane row) is the drop target. The `as*`
 * guards keep surface-specific data from leaking into generic drag handlers.
 */

/** The moved task's current coordinates — lets the drop handler diff for no-ops. */
export type TaskCardDragData = z.infer<typeof taskCardDragDataSchema>;

/**
 * A board axis value. Columns and swimlanes are the same three kinds; the
 * `kind` discriminant drives the ts-pattern `match` in the drop handler.
 * `project` with `projectId: null` is the "Inbox" (unassigned) axis value.
 */
export type BoardColumnKey =
  | { kind: "status"; status: TaskStatus }
  | { kind: "project"; projectId: ProjectShortcode | null; projectName: string }
  | { kind: "trade"; trade: Trade };

/** A swimlane row key — project or trade only (status is never a lane). */
export type BoardLaneKey =
  | { kind: "project"; projectId: ProjectShortcode | null; projectName: string }
  | { kind: "trade"; trade: Trade };

/** A cell drop target: its column, plus the lane row it sits in (null = no lanes). */
export type BoardDropData = z.infer<typeof boardDropDataSchema>;

/**
 * A card drop target: nested inside a cell target, it names the card the drop
 * landed on so the reorder knows "above/below card X". Carries the cell's
 * column/lane too, so a same-cell reorder (whose cell target `canDrop` returns
 * false — no axis change) can still resolve its coordinates from this alone.
 * The closest edge ("top"/"bottom") rides along via `attachClosestEdge`.
 */
export type BoardCardDropData = z.infer<typeof boardCardDropDataSchema>;

/** The fields a single drop can write — a subset of `taskUpdateData`. */
export type TaskBoardPatch = {
  status?: TaskStatus;
  projectId?: ProjectShortcode | null;
  trade?: Trade;
  /** Manual priority within the target cell (drag-to-prioritize). */
  sortOrder?: number;
};

/**
 * Fields a board quick-add can seed into the Task capture intent — derived from
 * whichever column (and, when swimlanes are on, lane) the "+" was clicked
 * from, so the created task lands directly in that cell.
 */
export type TaskCreatePreset = {
  status?: TaskStatus;
  projectId?: ProjectShortcode | null;
  trade?: Trade;
};

const projectAxisSchema = z.object({
  kind: z.literal("project"),
  projectId: projectShortcode.nullable(),
  projectName: z.string(),
});

const tradeAxisSchema = z.object({
  kind: z.literal("trade"),
  trade: tradeSchema,
});

const boardColumnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), status: taskStatusSchema }),
  projectAxisSchema,
  tradeAxisSchema,
]);

const boardLaneSchema = z.union([projectAxisSchema, tradeAxisSchema]);

const taskCardDragDataSchema = z.object({
  taskBoardDrag: z.literal(true),
  taskId: taskShortcode,
  status: taskStatusSchema,
  projectId: projectShortcode.nullable(),
  trade: tradeSchema,
});

const boardDropDataSchema = z.object({
  taskBoardTarget: z.literal(true),
  column: boardColumnSchema,
  lane: boardLaneSchema.nullable(),
});

const boardCardDropDataSchema = z.object({
  taskBoardCardTarget: z.literal(true),
  column: boardColumnSchema,
  lane: boardLaneSchema.nullable(),
  targetTaskId: taskShortcode,
});

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

export function asDragData(data: Data): TaskCardDragData | null {
  return taskCardDragDataSchema.safeParse(data).data ?? null;
}

export function asDropData(data: Data): BoardDropData | null {
  return boardDropDataSchema.safeParse(data).data ?? null;
}

export function asCardDropData(data: Data): BoardCardDropData | null {
  return boardCardDropDataSchema.safeParse(data).data ?? null;
}
