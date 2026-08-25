import type {
  TaskBoardInput,
  TaskFilters,
  TaskOut,
} from "@cubby/schemas/project";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";
import { useHydratedLoading } from "~/hooks/useHydrated";
import { taskBoardQueryOptions } from "../task.functions";
import { BoardControls } from "./BoardControls";
import type { BoardColsMode, BoardLaneMode } from "./board-model";
import { TaskBoard } from "./TaskBoard";
import type { BoardCacheTarget } from "./use-board-mutations";

/** Stable empty defaults — never a fresh `[]`/`{}` per render (would churn memos). */
const NO_TASKS: TaskOut[] = [];
const NO_BOARD: {
  active: TaskOut[];
  recentDone: TaskOut[];
  doneCount: number;
} = {
  active: NO_TASKS,
  recentDone: NO_TASKS,
  doneCount: 0,
};

const route = getRouteApi("/_authenticated/tasks/");

/**
 * Placeholder columns shown while the initial fetch is in flight — distinct
 * from the genuinely-empty board (which renders real columns with "No tasks"
 * cells). Five tracks mirrors the default status-columns layout.
 */
function BoardSkeleton() {
  return (
    <Row align="stretch" gap="sm" className="overflow-hidden">
      {Array.from({ length: 5 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder columns have no stable identity
        <Stack key={i} gap="sm" className="w-64 shrink-0">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </Stack>
      ))}
    </Row>
  );
}

/** The `/tasks?view=board` surface: URL-driven column/lane controls + the board. */
export function TasksBoardView({ filters }: { filters: TaskFilters }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();

  const cols: BoardColsMode = search.cols ?? "status";
  // Swimlanes are only meaningful with status columns.
  const lane: BoardLaneMode | null =
    cols === "status" ? (search.lane ?? null) : null;

  // Local state gives instant filtering while typing; the `q` URL param
  // (shared with the list view's deep-link seed) syncs on a debounce so
  // keystrokes don't flood router history — mirrors the list toolbar's pattern.
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

  // Server-filtered by name (task.board's `search`) — a narrower match than
  // the old client-side matchesSearch (which also matched project/trade/
  // status label text), traded for the server doing the active/done split +
  // done cap instead of a fetch-everything chartData read.
  const boardInput: TaskBoardInput = useMemo(
    () => ({ ...filters, search: debouncedSearch || undefined }),
    [filters, debouncedSearch],
  );
  const { data: board = NO_BOARD, isLoading: queryLoading } = useQuery(
    taskBoardQueryOptions(boardInput),
  );
  const isLoading = useHydratedLoading(queryLoading);
  const tasks = useMemo(() => [...board.active, ...board.recentDone], [board]);
  // The IDENTICAL `boardInput` this surface passed to `board.queryOptions`
  // above — `useBoardMutations` keys its optimistic patch off this so a drag
  // here now snaps instantly against the `task.board` cache, instead of
  // silently missing a `chartData` cache entry this page no longer populates.
  const cacheTarget: BoardCacheTarget = useMemo(
    () => ({ source: "board", input: boardInput }),
    [boardInput],
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
        search={searchValue}
        onSearchChange={setSearchValue}
      />
      <p className="text-muted-foreground text-xs">
        Board is a top-level layout and loads at most 20 recently completed
        cards.{" "}
        <a
          href="/tasks?view=list&status=done"
          className="underline underline-offset-2 hover:text-foreground"
        >
          View the complete Completed list
        </a>
        .
      </p>
      {isLoading ? (
        <BoardSkeleton />
      ) : (
        <TaskBoard
          tasks={tasks}
          cols={cols}
          lane={lane}
          cacheTarget={cacheTarget}
          showProjectOnCards
          doneCountOverride={board.doneCount}
        />
      )}
    </Stack>
  );
}
