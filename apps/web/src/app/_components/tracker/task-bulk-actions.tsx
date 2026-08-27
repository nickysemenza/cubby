import type { TaskShortcode } from "@cubby/schemas/identifiers";
import type { TaskOut, Trade } from "@cubby/schemas/project";
import { useMemo } from "react";
import { tradeOptions } from "~/app/projects/trade-options";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
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

/**
 * Every task bulk verb here is one kernel `bulkUpdate` over a declared field
 * mask — the id set differs, the patch differs, the command does not.
 */
const taskBulkUpdateOptions = entityMutationOptionsFactory(
  "task",
  "bulkUpdate",
);

export function useTaskBulkActions({
  includeDueDate = false,
  onCreateProject,
  extraActions = NO_EXTRA_ACTIONS,
}: {
  includeDueDate?: boolean;
  onCreateProject?: (ids: TaskShortcode[]) => void;
  extraActions?: BulkAction<TaskOut>[];
} = {}) {
  const taskCount = (data: { updated: number }) =>
    `${data.updated} task${data.updated !== 1 ? "s" : ""}`;
  const updated = (data: {
    updated: number;
    sideEffects: Parameters<typeof savedWithBackgroundWork>[0];
  }) => savedWithBackgroundWork(data.sideEffects, `Updated ${taskCount(data)}`);

  const move = useStagedBulkAction<TaskOut, typeof taskBulkUpdateOptions>({
    verb: "moveToProject",
    // The existing id is load-bearing: layouts persist per action id.
    id: "move",
    mutationFn: taskBulkUpdateOptions,
    success: (data) =>
      savedWithBackgroundWork(data.sideEffects, `Moved ${taskCount(data)}`),
  });
  const status = useStagedBulkAction<TaskOut, typeof taskBulkUpdateOptions>({
    verb: "setStatus",
    mutationFn: taskBulkUpdateOptions,
    success: updated,
  });
  const trade = useStagedBulkAction<TaskOut, typeof taskBulkUpdateOptions>({
    verb: "setTrade",
    mutationFn: taskBulkUpdateOptions,
    success: updated,
  });
  const dueDate = useStagedBulkAction<TaskOut, typeof taskBulkUpdateOptions>({
    verb: "setDueDate",
    mutationFn: taskBulkUpdateOptions,
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
          currentProject={(item) =>
            item.projectId
              ? { id: item.projectId, name: item.projectName ?? item.projectId }
              : null
          }
          isPending={move.isPending}
          onConfirm={async (projectId) => {
            await move.submit({ data: { projectId } });
            onComplete();
          }}
        />
      )}
      {status.items.length > 0 && (
        <SetTaskStatusDialog
          open
          onOpenChange={closed(status)}
          items={status.items}
          currentStatus={(item) => item.status}
          isPending={status.isPending}
          onConfirm={async (nextStatus) => {
            await status.submit({ data: { status: nextStatus } });
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
          currentValue={(item) => item.trade}
          options={tradeOptions}
          fieldLabel="Trade"
          itemNoun="Task"
          onConfirm={async (nextTrade) => {
            await trade.submit({ data: { trade: nextTrade as Trade } });
            onComplete();
          }}
        />
      )}
      {dueDate.items.length > 0 && (
        <SetDueDateDialog
          open
          onOpenChange={closed(dueDate)}
          items={dueDate.items}
          currentWindow={(item) => ({
            dueDate: item.dueDate,
            dueEndDate: item.dueEndDate,
          })}
          isPending={dueDate.isPending}
          onConfirm={async (nextDueDate, dueEndDate) => {
            await dueDate.submit({
              data: { dueDate: nextDueDate, dueEndDate },
            });
            onComplete();
          }}
        />
      )}
    </>
  );
}
