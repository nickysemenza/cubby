import type {
  TaskBoardInput,
  TaskFilters,
  TaskOut,
} from "@cubby/schemas/project";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { ListTodo } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { useHydratedLoading } from "~/hooks/useHydrated";
import { getErrorMessage } from "~/lib/error-utils";

import { task } from "../task.functions";
import type { BoardColsMode, BoardLaneMode } from "./board-model";

const boardColsSchema = z
  .enum(["status", "project", "trade"])
  .optional()
  .catch(undefined);
const boardLaneSchema = z
  .enum(["project", "trade"])
  .optional()
  .catch(undefined);
import { BoardControls } from "./BoardControls";
import { TaskBoard } from "./TaskBoard";
import type { BoardCacheTarget } from "./use-board-mutations";

/** Stable empty defaults — never a fresh `[]`/`{}` per render (would churn memos). */
const NO_TASKS: TaskOut[] = [];
const NO_BOARD = {
  active: NO_TASKS,
  recentDone: NO_TASKS,
  doneCount: 0,
} satisfies {
  active: TaskOut[];
  recentDone: TaskOut[];
  doneCount: number;
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

  // The generated search carries the board's keys as plain strings (the
  // slot's `searchKeys`); the board's own enums validate them here.
  const cols: BoardColsMode = boardColsSchema.parse(search.cols) ?? "status";
  // Swimlanes are only meaningful with status columns.
  const lane: BoardLaneMode | null =
    cols === "status" ? (boardLaneSchema.parse(search.lane) ?? null) : null;

  // Local state gives instant filtering while typing; the `q` URL param
  // (shared with the list view's deep-link seed) syncs on a debounce so
  // keystrokes don't flood router history — mirrors the list toolbar's pattern.
  const [searchValue, setSearchValue] = useState(search.q ?? "");
  const [debouncedSearch] = useDebouncedValue(searchValue, { wait: 500 });

  // navigate is a stable tanstack-router reference; including it would
  // re-run this on every render for no reason.
  useEffect(() => {
    navigate({
      search: (prev) => ({ ...prev, q: debouncedSearch || undefined }),
      replace: true,
    });
    // oxlint-disable-next-line react/exhaustive-deps -- navigate is intentionally excluded
  }, [debouncedSearch]);

  // Server-filtered by name (task.board's `search`) — a narrower match than
  // the old client-side matchesSearch (which also matched project/trade/
  // status label text), traded for the server doing the active/done split +
  // done cap instead of a fetch-everything chartData read.
  const boardInput: TaskBoardInput = useMemo(
    () => ({ ...filters, search: debouncedSearch || undefined }),
    [filters, debouncedSearch],
  );
  const {
    data: board = NO_BOARD,
    isLoading: queryLoading,
    isError,
    error,
    refetch,
  } = useQuery(task.board.queryOptions(boardInput));
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
      <p className="text-xs text-muted-foreground">
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
      {isError && board === NO_BOARD ? (
        // A failed read is not an empty board: "No tasks to show" here once
        // hid a 500 behind what looked like lost data.
        <Empty>
          <EmptyHeader>
            <EmptyIcon icon={ListTodo} />
            <EmptyTitle>Couldn't load tasks</EmptyTitle>
            <EmptyDescription>{getErrorMessage(error)}</EmptyDescription>
          </EmptyHeader>
          <EmptyActions>
            <Button type="button" variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          </EmptyActions>
        </Empty>
      ) : isLoading ? (
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
