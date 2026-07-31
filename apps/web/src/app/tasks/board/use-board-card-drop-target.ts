import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  attachClosestEdge,
  type Edge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { TaskShortcode } from "@cubby/schemas/identifiers";
import { type RefObject, useEffect, useState } from "react";
import type { BoardColumnKey, BoardLaneKey } from "./board-types";
import { asDragData, type BoardCardDropData } from "./board-types";

interface BoardCardDropTargetOptions<T extends HTMLElement> {
  ref: RefObject<T | null>;
  column: BoardColumnKey;
  lane: BoardLaneKey | null;
  taskId: TaskShortcode;
  /**
   * The Done status column opts out of manual ranking — its cards aren't
   * reorder targets (they sort by recency), so no edge indicator and the drop
   * falls through to the cell target (a pure status change). See board-model.
   */
  disabled: boolean;
}

/**
 * Registers a card as a nested reorder drop target and reports the closest
 * edge ("top"/"bottom") the cursor is hovering, for the 2px drop indicator.
 * `attachClosestEdge` rides the edge on the drop data; the monitor
 * (`use-board-dnd`) reads it back with `extractClosestEdge`. Nested inside the
 * cell target — pragmatic-dnd surfaces both; the monitor prefers this one.
 */
export function useBoardCardDropTarget<T extends HTMLElement>({
  ref,
  column,
  lane,
  taskId,
  disabled,
}: BoardCardDropTargetOptions<T>): Edge | null {
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || disabled) return;
    return dropTargetForElements({
      element,
      getData: ({ input }): BoardCardDropData & Record<string, unknown> =>
        attachClosestEdge(
          { taskBoardCardTarget: true, column, lane, targetTaskId: taskId },
          { element, input, allowedEdges: ["top", "bottom"] },
        ) as BoardCardDropData & Record<string, unknown>,
      // A card can't reorder relative to itself.
      canDrop: ({ source }) => {
        const drag = asDragData(source.data);
        return drag != null && drag.taskId !== taskId;
      },
      onDragEnter: ({ self }) => setClosestEdge(extractClosestEdge(self.data)),
      onDrag: ({ self }) => setClosestEdge(extractClosestEdge(self.data)),
      onDragLeave: () => setClosestEdge(null),
      onDrop: () => setClosestEdge(null),
    });
  }, [column, lane, taskId, disabled, ref]);

  return disabled ? null : closestEdge;
}
