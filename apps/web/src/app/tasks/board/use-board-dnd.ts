import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { TaskId } from "@cubby/schemas/identifiers";
import type { TaskBulkReorderInput, TaskOut } from "@cubby/schemas/project";
import { useEffect, useRef } from "react";
import { cellTasks, computeMove, computeRank } from "./board-model";
import {
  asCardDropData,
  asDragData,
  asDropData,
  type TaskBoardPatch,
} from "./board-types";

interface UseBoardDndArgs {
  /** The board's full task list — the target cell's ordering is derived from it. */
  tasks: TaskOut[];
  moveTask: (taskId: TaskId, patch: TaskBoardPatch) => void;
  reorderTasks: (input: TaskBulkReorderInput) => void;
}

/**
 * The single `monitorForElements` that turns a valid drop into a write. Two
 * shapes of drop:
 *
 *   - **empty-space / cell drop** — only a cell target: axis change only
 *     (status/project/trade), today's behavior, no manual rank written.
 *   - **card-edge drop** — a nested card target names the card and edge:
 *     {@link computeRank} resolves the manual `sortOrder`. A single midpoint
 *     folds into one `task.update` (axis + rank); a materialize run goes to
 *     `task.bulkReorder` (with the axis move folded in when cells also changed).
 *
 * The Done status column opts out of ranking — its cards never register as card
 * targets, so a drop there resolves via the cell target (a pure status change).
 * Callbacks live in refs so the monitor registers once.
 */
export function useBoardDnd({
  tasks,
  moveTask,
  reorderTasks,
}: UseBoardDndArgs): void {
  const moveTaskRef = useRef(moveTask);
  moveTaskRef.current = moveTask;
  const reorderTasksRef = useRef(reorderTasks);
  reorderTasksRef.current = reorderTasks;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  useEffect(() => {
    return monitorForElements({
      onDrop({ source, location }) {
        const drag = asDragData(source.data);
        if (!drag) return;

        const targets = location.current.dropTargets;
        // A card-edge drop nests a card target inside the cell target; both may
        // pass canDrop, so find each explicitly rather than by z-order.
        const cardTargetRaw = targets.find((t) => asCardDropData(t.data));
        const cardDrop = cardTargetRaw
          ? asCardDropData(cardTargetRaw.data)
          : null;
        const cellDrop =
          targets.map((t) => asDropData(t.data)).find((d) => d != null) ?? null;

        // The card target carries the cell coordinates too, so it alone
        // suffices when the cell target's canDrop rejected a same-cell reorder.
        const context = cardDrop ?? cellDrop;
        if (!context) return;
        const { column, lane } = context;

        // No card target (empty-space drop): axis change only, no rank write.
        if (!cardTargetRaw || !cardDrop) {
          const patch = computeMove(drag, { column, lane });
          if (patch) moveTaskRef.current(drag.taskId, patch);
          return;
        }

        // Card-edge drop: place the dragged card relative to the target card.
        const edge = extractClosestEdge(cardTargetRaw.data);
        const cellCards = cellTasks(
          tasksRef.current,
          column,
          lane,
        ).cards.filter((c) => c.id !== drag.taskId);
        const targetPos = cellCards.findIndex(
          (c) => c.id === cardDrop.targetTaskId,
        );
        const draggedCard = tasksRef.current.find((t) => t.id === drag.taskId);
        if (targetPos === -1 || !draggedCard) {
          // Target vanished from the cell (stale) — fall back to axis-only.
          const patch = computeMove(drag, { column, lane });
          if (patch) moveTaskRef.current(drag.taskId, patch);
          return;
        }

        const insertIndex = edge === "bottom" ? targetPos + 1 : targetPos;
        const ordered = [
          ...cellCards.slice(0, insertIndex),
          draggedCard,
          ...cellCards.slice(insertIndex),
        ];
        const outcome = computeRank(ordered, insertIndex);

        if (outcome.kind === "single") {
          const patch = computeMove(drag, { column, lane }, outcome.sortOrder);
          if (patch) moveTaskRef.current(drag.taskId, patch);
          return;
        }

        // Materialize: re-rank a run of cards; fold in the axis move if the
        // drop also crossed cells.
        const axisPatch = computeMove(drag, { column, lane });
        reorderTasksRef.current({
          ranks: outcome.ranks,
          move: axisPatch ? { id: drag.taskId, patch: axisPatch } : undefined,
        });
      },
    });
  }, []);
}
