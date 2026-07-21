import type { TaskOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Stack } from "~/components/layout";
import { useTRPC } from "~/integrations/trpc/react";
import { BoardControls } from "./BoardControls";
import type { BoardColsMode, BoardLaneMode } from "./board-model";
import { TaskBoard } from "./TaskBoard";
import type { BoardTaskFilters } from "./use-board-mutations";

/**
 * The board fetches every top-level task in one round trip (chart/Gantt
 * convention). Declared once at module scope so the optimistic mutation patches
 * the *identical* query key — a fresh object literal would key differently.
 */
const BOARD_TASK_FILTERS: BoardTaskFilters = { topLevelOnly: true };

/** Stable empty default — never a fresh `[]` per render (would churn memos). */
const NO_TASKS: TaskOut[] = [];

const route = getRouteApi("/_authenticated/tasks/");

/** The `/tasks?view=board` surface: URL-driven column/lane controls + the board. */
export function TasksBoardView() {
  const api = useTRPC();
  const search = route.useSearch();
  const navigate = route.useNavigate();

  const cols: BoardColsMode = search.cols ?? "status";
  // Swimlanes are only meaningful with status columns.
  const lane: BoardLaneMode | null =
    cols === "status" ? (search.lane ?? null) : null;

  const { data: tasks = NO_TASKS } = useQuery(
    api.task.chartData.queryOptions(BOARD_TASK_FILTERS),
  );

  const setCols = (next: BoardColsMode) =>
    // Merge-navigate (preserve `q`); drop `cols` when it's the default to keep
    // URLs clean, and clear `lane` whenever columns leave status mode.
    navigate({
      search: (prev) => ({
        ...prev,
        cols: next === "status" ? undefined : next,
        lane: next === "status" ? prev.lane : undefined,
      }),
    });

  const setLane = (next: BoardLaneMode | null) =>
    navigate({ search: (prev) => ({ ...prev, lane: next ?? undefined }) });

  return (
    <Stack gap="md">
      <BoardControls
        cols={cols}
        lane={lane}
        onColsChange={setCols}
        onLaneChange={setLane}
      />
      <TaskBoard
        tasks={tasks}
        cols={cols}
        lane={lane}
        filters={BOARD_TASK_FILTERS}
        showProjectOnCards
      />
    </Stack>
  );
}
