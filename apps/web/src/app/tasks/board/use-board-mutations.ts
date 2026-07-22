import { type TaskId, unsafeProjectId } from "@cubby/schemas/identifiers";
import type { TaskBulkReorderInput, TaskOut } from "@cubby/schemas/project";
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

type OptimisticContext = { prev: TaskOut[] | undefined };

/**
 * The one board mutation: patch a task's status/project/trade from a drop (or
 * the card's status quick-action). This is the sanctioned raw-`useMutation`
 * carve-out (like `use-arrange-mutations`) because the optimistic write is
 * surgical — it patches the *exact* `task.chartData` cache for this surface's
 * filters so the derived sort re-places the card instantly, then reconciles via
 * an `onSettled` invalidation.
 *
 * The `filters` MUST be the identical object the surface passed to
 * `chartData.queryOptions` (share a constant) — a different shape produces a
 * different query key and the optimistic patch silently misses.
 */
export function useBoardMutations(filters: BoardTaskFilters) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const chartKey = api.task.chartData.queryKey(filters);

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
    onMutate: async (vars): Promise<OptimisticContext> => {
      await cancelTRPCQueries(queryClient, [chartKey]);
      const prev = queryClient.getQueryData<TaskOut[]>(chartKey);
      if (prev) {
        queryClient.setQueryData<TaskOut[]>(
          chartKey,
          prev.map((t) =>
            t.id === vars.id ? patchTaskFields(t, vars.data, prev) : t,
          ),
        );
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(chartKey, ctx.prev);
      toast.error(getErrorMessage(err));
    },
    onSettled: () =>
      invalidateTRPCQueries(queryClient, taskMutationInvalidateKeys),
  });

  // The board's "materialize" reorder — a run of sortOrder writes plus an
  // optional axis move on the dragged card. Optimistically patches every
  // affected id in the same chartData cache so the manual prefix re-orders
  // instantly, then reconciles via onSettled.
  const reorderBase = api.task.bulkReorder.mutationOptions();
  const reorder = useMutation({
    mutationKey: reorderBase.mutationKey,
    mutationFn: reorderBase.mutationFn,
    onMutate: async (vars): Promise<OptimisticContext> => {
      await cancelTRPCQueries(queryClient, [chartKey]);
      const prev = queryClient.getQueryData<TaskOut[]>(chartKey);
      if (prev) {
        const rankById = new Map(vars.ranks.map((r) => [r.id, r.sortOrder]));
        const move = vars.move;
        queryClient.setQueryData<TaskOut[]>(
          chartKey,
          prev.map((t) => {
            const sortOrder = rankById.get(t.id);
            let next = sortOrder !== undefined ? { ...t, sortOrder } : t;
            if (move && t.id === move.id) {
              next = patchTaskFields(next, move.patch, prev);
            }
            return next;
          }),
        );
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(chartKey, ctx.prev);
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
