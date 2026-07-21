import type { TaskOut } from "@cubby/schemas/project";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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

/** Case-insensitive substring match on task name or project name. */
function matchesSearch(task: TaskOut, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    task.name.toLowerCase().includes(needle) ||
    (task.projectName?.toLowerCase().includes(needle) ?? false)
  );
}

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

  // Local state gives instant filtering while typing; the `q` URL param
  // (shared with the list view's deep-link seed) syncs on a debounce so
  // keystrokes don't flood router history — mirrors HeaderFilter's pattern.
  const [searchValue, setSearchValue] = useState(search.q ?? "");
  const [debouncedSearch] = useDebouncedValue(searchValue, { wait: 500 });

  // navigate is a stable tanstack-router reference; including it would
  // re-run this on every render for no reason.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigate is intentionally excluded
  useEffect(() => {
    navigate({
      search: (prev) => ({ ...prev, q: debouncedSearch || undefined }),
      replace: true,
    });
  }, [debouncedSearch]);

  const filteredTasks = useMemo(() => {
    const query = searchValue.trim();
    return query ? tasks.filter((t) => matchesSearch(t, query)) : tasks;
  }, [tasks, searchValue]);

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
        search={searchValue}
        onSearchChange={setSearchValue}
      />
      <TaskBoard
        tasks={filteredTasks}
        cols={cols}
        lane={lane}
        filters={BOARD_TASK_FILTERS}
        showProjectOnCards
      />
    </Stack>
  );
}
