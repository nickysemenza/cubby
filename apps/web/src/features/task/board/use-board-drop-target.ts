import { useDroppable } from "@dnd-kit/core";

import type {
  BoardColumnKey,
  BoardDropData,
  BoardLaneKey,
} from "./board-types";

/** Registers a board cell as the axis-changing target; empty cells stay valid. */
export function useBoardDropTarget({
  column,
  lane,
}: {
  column: BoardColumnKey;
  lane: BoardLaneKey | null;
}) {
  return useDroppable({
    id: `task-board:cell:${axisId(column)}:${lane ? axisId(lane) : "none"}`,
    data: { taskBoardTarget: true, column, lane } satisfies BoardDropData,
  });
}

function axisId(key: BoardColumnKey | BoardLaneKey): string {
  switch (key.kind) {
    case "status":
      return `status:${key.status}`;
    case "project":
      return `project:${key.projectId ?? "inbox"}`;
    case "trade":
      return `trade:${key.trade}`;
  }
}
