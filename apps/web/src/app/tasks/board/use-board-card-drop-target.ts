import type { TaskShortcode } from "@cubby/schemas/identifiers";
import { useDroppable } from "@dnd-kit/core";
import type {
  BoardCardDropData,
  BoardColumnKey,
  BoardLaneKey,
} from "./board-types";

/** A reorder target nested in a board cell. Done cards intentionally opt out. */
export function useBoardCardDropTarget({
  column,
  lane,
  taskId,
  disabled,
}: {
  column: BoardColumnKey;
  lane: BoardLaneKey | null;
  taskId: TaskShortcode;
  disabled: boolean;
}) {
  return useDroppable({
    id: `task-board:card:${taskId}`,
    disabled,
    data: {
      taskBoardCardTarget: true,
      column,
      lane,
      targetTaskId: taskId,
    } satisfies BoardCardDropData,
  });
}
