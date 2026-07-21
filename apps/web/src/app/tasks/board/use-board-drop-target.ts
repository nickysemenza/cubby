import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { type RefObject, useEffect, useState } from "react";
import { computeMove } from "./board-model";
import type { BoardColumnKey, BoardLaneKey } from "./board-types";
import { asDragData, type BoardDropData } from "./board-types";

interface BoardDropTargetOptions<T extends HTMLElement> {
  ref: RefObject<T | null>;
  column: BoardColumnKey;
  lane: BoardLaneKey | null;
}

/**
 * Registers a board cell as a drop target and exposes its hover state (for the
 * ring highlight). `canDrop` refuses a no-op drop back onto the moved task's
 * own cell — {@link computeMove} returning null is the single source of truth
 * for "nothing would change". Mirrors `use-arrange-drop-target`.
 */
export function useBoardDropTarget<T extends HTMLElement>({
  ref,
  column,
  lane,
}: BoardDropTargetOptions<T>): boolean {
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return dropTargetForElements({
      element,
      getData: (): BoardDropData & Record<string, unknown> => ({
        taskBoardTarget: true,
        column,
        lane,
      }),
      canDrop: ({ source }) => {
        const drag = asDragData(source.data);
        if (!drag) return false;
        return computeMove(drag, { column, lane }) != null;
      },
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: () => setIsOver(false),
    });
  }, [column, lane, ref]);

  return isOver;
}
