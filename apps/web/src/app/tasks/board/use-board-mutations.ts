import { type TaskId, unsafeProjectId } from "@cubby/schemas/identifiers";
import type {
  TaskBoardInput,
  TaskBoardOut,
  TaskBulkReorderInput,
  TaskOut,
} from "@cubby/schemas/project";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { type RouterInputs, useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import {
  cancelTRPCQueries,
  invalidateTRPCQueries,
  taskMutationInvalidateKeys,
} from "~/lib/query-keys";
import type { TaskBoardPatch } from "./board-types";

/**
 * The board's `chartData` filters — the tRPC *input* type (branded ids widen to
 * `string`), so `projectSubtreeTasksFilters` and a bare `{ topLevelOnly: true }`
 * both fit. The same value keys the query and this optimistic patch.
 */
export type BoardTaskFilters = RouterInputs["task"]["chartData"];

/**
 * Which query cache `useBoardMutations` optimistically patches — the project
 * detail embed still reads the full subtree via `task.chartData` (a flat
 * `TaskOut[]`), while the standalone `/tasks?view=board` page reads the
 * capped `task.board` (`{active, recentDone, doneCount}`). Both need the
 * SAME identity object the surface passed to its own `queryOptions` call — a
 * different shape produces a different query key and the patch silently
 * misses.
 */
export type BoardCacheTarget =
  | { source: "chartData"; filters: BoardTaskFilters }
  | { source: "board"; input: TaskBoardInput };

type OptimisticContext<TData> = { prev: TData | undefined };

/** Read the flat task list out of whichever cache shape `target` points at. */
function readFlatList(
  data: TaskOut[] | TaskBoardOut | undefined,
  source: BoardCacheTarget["source"],
): TaskOut[] | undefined {
  if (!data) return undefined;
  return source === "chartData"
    ? (data as TaskOut[])
    : [...(data as TaskBoardOut).active, ...(data as TaskBoardOut).recentDone];
}

/**
 * Rebuild the cache value from a patched flat list. For `task.board`, one
 * task's status may have flipped in/out of "done" as part of this patch —
 * `recentDone`'s length shift (always ±1 or 0 for the single-task/
 * single-move patches this hook makes) is applied to `doneCount` too, so the
 * server-true total stays consistent with the locally-visible slice until
 * `onSettled`'s refetch corrects both precisely.
 */
function writeFlatList(
  prevData: TaskOut[] | TaskBoardOut,
  nextList: TaskOut[],
  source: BoardCacheTarget["source"],
): TaskOut[] | TaskBoardOut {
  if (source === "chartData") return nextList;
  const prevBoard = prevData as TaskBoardOut;
  const active = nextList.filter((t) => t.status !== "done");
  const recentDone = nextList.filter((t) => t.status === "done");
  const doneCount =
    prevBoard.doneCount + (recentDone.length - prevBoard.recentDone.length);
  return { active, recentDone, doneCount };
}

/**
 * The board's two mutations: a single task move (drop or status quick-action)
 * and the "materialize" bulk reorder. This is the sanctioned raw-`useMutation`
 * carve-out (like `use-arrange-mutations`) because the optimistic write is
 * surgical — it patches the exact cache `target` points at so the derived
 * sort/column re-places the card instantly, then reconciles via an
 * `onSettled` invalidation.
 */
export function useBoardMutations(target: BoardCacheTarget) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const queryKey: QueryKey =
    target.source === "chartData"
      ? api.task.chartData.queryKey(target.filters)
      : api.task.board.queryKey(target.input);

  const patchTaskFields = (
    task: TaskOut,
    data: {
      status?: TaskOut["status"];
      trade?: TaskOut["trade"];
      projectId?: string | null;
      sortOrder?: number | null;
    },
    prev: TaskOut[],
  ): TaskOut => {
    // projectName isn't in the payload — resolve it from a sibling already in
    // the target project (best-effort; onSettled reconciles).
    const nextProjectName =
      "projectId" in data
        ? data.projectId == null
          ? null
          : (prev.find((t) => t.projectId === data.projectId)?.projectName ??
            null)
        : undefined;
    return {
      ...task,
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.trade !== undefined ? { trade: data.trade } : {}),
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      ...("projectId" in data
        ? {
            // Re-brand at the string→domain boundary (mutation inputs widen
            // branded ids to plain `string`).
            projectId:
              data.projectId == null ? null : unsafeProjectId(data.projectId),
            projectName: nextProjectName ?? null,
          }
        : {}),
      // Bump so a just-completed task floats to the top of the Done column's
      // most-recently-updated cap.
      updatedAt: new Date(),
    };
  };

  const base = api.task.update.mutationOptions();
  const update = useMutation({
    mutationKey: base.mutationKey,
    mutationFn: base.mutationFn,
    onMutate: async (
      vars,
    ): Promise<OptimisticContext<TaskOut[] | TaskBoardOut>> => {
      await cancelTRPCQueries(queryClient, [queryKey]);
      const prev = queryClient.getQueryData<TaskOut[] | TaskBoardOut>(queryKey);
      const flat = readFlatList(prev, target.source);
      if (prev && flat) {
        const nextList = flat.map((t) =>
          t.id === vars.id ? patchTaskFields(t, vars.data, flat) : t,
        );
        queryClient.setQueryData(
          queryKey,
          writeFlatList(prev, nextList, target.source),
        );
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(queryKey, ctx.prev);
      toast.error(getErrorMessage(err));
    },
    onSettled: () =>
      invalidateTRPCQueries(queryClient, taskMutationInvalidateKeys),
  });

  // The board's "materialize" reorder — a run of sortOrder writes plus an
  // optional axis move on the dragged card. Optimistically patches every
  // affected id in the same cache so the manual prefix re-orders instantly,
  // then reconciles via onSettled.
  const reorderBase = api.task.bulkReorder.mutationOptions();
  const reorder = useMutation({
    mutationKey: reorderBase.mutationKey,
    mutationFn: reorderBase.mutationFn,
    onMutate: async (
      vars,
    ): Promise<OptimisticContext<TaskOut[] | TaskBoardOut>> => {
      await cancelTRPCQueries(queryClient, [queryKey]);
      const prev = queryClient.getQueryData<TaskOut[] | TaskBoardOut>(queryKey);
      const flat = readFlatList(prev, target.source);
      if (prev && flat) {
        const rankById = new Map(vars.ranks.map((r) => [r.id, r.sortOrder]));
        const move = vars.move;
        const nextList = flat.map((t) => {
          const sortOrder = rankById.get(t.id);
          let next = sortOrder !== undefined ? { ...t, sortOrder } : t;
          if (move && t.id === move.id) {
            next = patchTaskFields(next, move.patch, flat);
          }
          return next;
        });
        queryClient.setQueryData(
          queryKey,
          writeFlatList(prev, nextList, target.source),
        );
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(queryKey, ctx.prev);
      toast.error(getErrorMessage(err));
    },
    onSettled: () =>
      invalidateTRPCQueries(queryClient, taskMutationInvalidateKeys),
  });

  return {
    moveTask: (taskId: TaskId, patch: TaskBoardPatch) =>
      update.mutate({ id: taskId, data: patch }),
    reorderTasks: (input: TaskBulkReorderInput) => reorder.mutate(input),
  };
}
