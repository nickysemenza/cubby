import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { TaskId } from "@cubby/schemas/identifiers";
import { useEffect, useRef } from "react";
import { computeMove } from "./board-model";
import { asDragData, asDropData, type TaskBoardPatch } from "./board-types";

interface UseBoardDndArgs {
  moveTask: (taskId: TaskId, patch: TaskBoardPatch) => void;
}

/**
 * The single `monitorForElements` that turns a valid drop into one
 * `task.update`. Each cell's own `canDrop` already gated validity for the
 * cursor; this re-diffs drag-vs-drop with {@link computeMove} as the backstop
 * (a null patch = no-op, bail). The callback lives in a ref so the monitor is
 * registered once and never needs re-binding. Mirrors `use-arrange-dnd`.
 */
export function useBoardDnd({ moveTask }: UseBoardDndArgs): void {
  const moveTaskRef = useRef(moveTask);
  moveTaskRef.current = moveTask;

  useEffect(() => {
    return monitorForElements({
      onDrop({ source, location }) {
        const drag = asDragData(source.data);
        if (!drag) return;
        const target = location.current.dropTargets[0];
        if (!target) return;
        const drop = asDropData(target.data);
        if (!drop) return;

        const patch = computeMove(drag, drop);
        if (patch) moveTaskRef.current(drag.taskId, patch);
      },
    });
  }, []);
}
