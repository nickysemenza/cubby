import type { TaskShortcode } from "@cubby/schemas/identifiers";
import type { TaskOut, Trade } from "@cubby/schemas/project";
import { useMemo } from "react";
import { tradeOptions } from "~/app/projects/trade-options";
import { task } from "~/app/tasks/task.functions";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { verbBulkAction } from "../actions/action-verb-ui";
import type {
  BulkAction,
  BulkActionsConfig,
} from "../data-table/bulk-actions.types";
import { useStagedBulkAction } from "../hooks/useStagedBulkAction";
import { MoveToProjectDialog } from "./move-to-project-dialog";
import { SetDueDateDialog } from "./set-due-date-dialog";
import { SetFieldDialog } from "./set-field-dialog";
import { SetTaskStatusDialog } from "./set-task-status-dialog";

const NO_EXTRA_ACTIONS: BulkAction<TaskOut>[] = [];

export function useTaskBulkActions({
  includeDueDate = false,
  onCreateProject,
  extraActions = NO_EXTRA_ACTIONS,
}: {
  includeDueDate?: boolean;
  onCreateProject?: (ids: TaskShortcode[]) => void;
  extraActions?: BulkAction<TaskOut>[];
} = {}) {
  const taskCount = (data: { items: unknown[] }) =>
    `${data.items.length} task${data.items.length !== 1 ? "s" : ""}`;
  const updated = (data: {
    items: unknown[];
    sideEffects: Parameters<typeof savedWithBackgroundWork>[0];
  }) => savedWithBackgroundWork(data.sideEffects, `Updated ${taskCount(data)}`);

  const move = useStagedBulkAction<
    TaskOut,
    typeof task.bulkMove.mutationOptions
  >({
    verb: "moveToProject",
    // The existing id is load-bearing: layouts persist per action id.
    id: "move",
    mutationFn: task.bulkMove.mutationOptions,
    success: (data) =>
      savedWithBackgroundWork(data.sideEffects, `Moved ${taskCount(data)}`),
  });
  const status = useStagedBulkAction<
    TaskOut,
    typeof task.bulkSetStatus.mutationOptions
  >({
    verb: "setStatus",
    mutationFn: task.bulkSetStatus.mutationOptions,
    success: updated,
  });
  const trade = useStagedBulkAction<
    TaskOut,
    typeof task.bulkSetTrade.mutationOptions
  >({
    verb: "setTrade",
    mutationFn: task.bulkSetTrade.mutationOptions,
    success: updated,
  });
  const dueDate = useStagedBulkAction<
    TaskOut,
    typeof task.bulkSetDueDate.mutationOptions
  >({
    verb: "setDueDate",
    mutationFn: task.bulkSetDueDate.mutationOptions,
    success: updated,
  });

  const config = useMemo<BulkActionsConfig<TaskOut>>(
    () => ({
      actions: [
        move.action,
        status.action,
        trade.action,
        ...(includeDueDate ? [dueDate.action] : []),
        // Not a staged mutation: the caller owns the project-creation flow.
        ...(onCreateProject
          ? [
              verbBulkAction<TaskOut>("createProjectFrom", {
                id: "create-project",
                minSelection: 1,
                onExecute: async (rows) => {
                  onCreateProject(rows.map((row) => row.original.id));
                  return { success: true };
                },
              }),
            ]
          : []),
        ...extraActions,
      ],
      clearSelectionOnComplete: false,
    }),
    [
      extraActions,
      includeDueDate,
      onCreateProject,
      move.action,
      status.action,
      trade.action,
      dueDate.action,
    ],
  );

  return { config, move, status, trade, dueDate };
}

export type TaskBulkActionsController = ReturnType<typeof useTaskBulkActions>;

export function TaskBulkActionDialogs({
  controller,
  onComplete,
}: {
  controller: TaskBulkActionsController;
  /** Runs after a successful write — the surface clears its row selection. */
  onComplete: () => void;
}) {
  const { move, status, trade, dueDate } = controller;
  const closed = (staged: { cancel: () => void }) => (open: boolean) => {
    if (!open) staged.cancel();
  };

  return (
    <>
      {move.items.length > 0 && (
        <MoveToProjectDialog
          open
          onOpenChange={closed(move)}
          items={move.items}
          entityLabel="Task"
          isPending={move.isPending}
          onConfirm={async (projectId) => {
            await move.submit({ projectId });
            onComplete();
          }}
        />
      )}
      {status.items.length > 0 && (
        <SetTaskStatusDialog
          open
          onOpenChange={closed(status)}
          items={status.items}
          isPending={status.isPending}
          onConfirm={async (nextStatus) => {
            await status.submit({ status: nextStatus });
            onComplete();
          }}
        />
      )}
      {trade.items.length > 0 && (
        <SetFieldDialog
          open
          onOpenChange={closed(trade)}
          items={trade.items}
          isPending={trade.isPending}
          options={tradeOptions}
          fieldLabel="Trade"
          itemNoun="Task"
          onConfirm={async (nextTrade) => {
            await trade.submit({ trade: nextTrade as Trade });
            onComplete();
          }}
        />
      )}
      {dueDate.items.length > 0 && (
        <SetDueDateDialog
          open
          onOpenChange={closed(dueDate)}
          items={dueDate.items}
          isPending={dueDate.isPending}
          onConfirm={async (nextDueDate, dueEndDate) => {
            await dueDate.submit({ dueDate: nextDueDate, dueEndDate });
            onComplete();
          }}
        />
      )}
    </>
  );
}
