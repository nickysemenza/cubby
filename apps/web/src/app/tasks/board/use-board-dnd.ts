import type { TaskShortcode } from "@cubby/schemas/identifiers";
import type { TaskBulkReorderInput, TaskOut } from "@cubby/schemas/project";
import type { DragEndEvent } from "@dnd-kit/core";
import { useCallback, useRef } from "react";
import { cellTasks, computeMove, computeRank } from "./board-model";
import {
  asCardDropData,
  asDragData,
  asDropData,
  type TaskBoardPatch,
} from "./board-types";

interface UseBoardDndArgs {
  tasks: TaskOut[];
  moveTask: (taskId: TaskShortcode, patch: TaskBoardPatch) => void;
  reorderTasks: (input: TaskBulkReorderInput) => void;
}

/** Resolves dnd-kit's typed active/over records through the board model. */
export function useBoardDnd({
  tasks,
  moveTask,
  reorderTasks,
}: UseBoardDndArgs): (event: DragEndEvent) => void {
  const latest = useRef({ tasks, moveTask, reorderTasks });
  latest.current = { tasks, moveTask, reorderTasks };

  return useCallback((event: DragEndEvent) => {
    const drag = asDragData(event.active.data.current ?? {});
    if (!drag || !event.over) return;
    const cardDrop = asCardDropData(event.over.data.current ?? {});
    const cellDrop = asDropData(event.over.data.current ?? {});
    const context = cardDrop ?? cellDrop;
    if (!context) return;

    const current = latest.current;
    if (!cardDrop) {
      const patch = computeMove(drag, context);
      if (patch) current.moveTask(drag.taskId, patch);
      return;
    }
    if (cardDrop.targetTaskId === drag.taskId) return;

    const cellCards = cellTasks(
      current.tasks,
      context.column,
      context.lane,
    ).cards.filter((card) => card.id !== drag.taskId);
    const targetPos = cellCards.findIndex(
      (card) => card.id === cardDrop.targetTaskId,
    );
    const draggedCard = current.tasks.find((task) => task.id === drag.taskId);
    if (targetPos === -1 || !draggedCard) {
      const patch = computeMove(drag, context);
      if (patch) current.moveTask(drag.taskId, patch);
      return;
    }

    const insertIndex =
      edgeForDrop(event) === "bottom" ? targetPos + 1 : targetPos;
    const ordered = [
      ...cellCards.slice(0, insertIndex),
      draggedCard,
      ...cellCards.slice(insertIndex),
    ];
    const outcome = computeRank(ordered, insertIndex);
    if (outcome.kind === "single") {
      const patch = computeMove(drag, context, outcome.sortOrder);
      if (patch) current.moveTask(drag.taskId, patch);
      return;
    }

    const axisPatch = computeMove(drag, context);
    current.reorderTasks({
      ranks: outcome.ranks,
      move: axisPatch ? { id: drag.taskId, patch: axisPatch } : undefined,
    });
  }, []);
}

export function edgeForDrop(
  event: Pick<DragEndEvent, "active" | "over">,
): "top" | "bottom" {
  const translated = event.active.rect.current.translated;
  if (!translated || !event.over) return "top";
  return translated.top + translated.height / 2 >=
    event.over.rect.top + event.over.rect.height / 2
    ? "bottom"
    : "top";
}
