import type { TaskShortcode } from "@cubby/schemas/identifiers";
import type { TaskOut, Trade } from "@cubby/schemas/project";
import type { Row } from "@tanstack/react-table";
import {
  ArrowRightLeft,
  CalendarClock,
  ListChecks,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { tradeOptions } from "~/app/projects/trade-options";
import { useTRPC } from "~/integrations/trpc/react";
import { taskMutationInvalidateKeys } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import type {
  BulkAction,
  BulkActionsConfig,
} from "../data-table/bulk-actions.types";
import { useActionMutation } from "../hooks/useActionMutation";
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
  const [moveItems, setMoveItems] = useState<TaskOut[]>([]);
  const [statusItems, setStatusItems] = useState<TaskOut[]>([]);
  const [tradeItems, setTradeItems] = useState<TaskOut[]>([]);
  const [dueDateItems, setDueDateItems] = useState<TaskOut[]>([]);

  const config = useMemo<BulkActionsConfig<TaskOut>>(
    () => ({
      actions: [
        {
          id: "move",
          label: "Move to project...",
          icon: <ArrowRightLeft className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<TaskOut>[]) => {
            setMoveItems(rows.map((row) => row.original));
            return { success: true };
          },
        },
        {
          id: "set-status",
          label: "Set status...",
          icon: <ListChecks className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<TaskOut>[]) => {
            setStatusItems(rows.map((row) => row.original));
            return { success: true };
          },
        },
        {
          id: "set-trade",
          label: "Set trade...",
          icon: <Wrench className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<TaskOut>[]) => {
            setTradeItems(rows.map((row) => row.original));
            return { success: true };
          },
        },
        ...(includeDueDate
          ? [
              {
                id: "set-due-date",
                label: "Set due date...",
                icon: <CalendarClock className="size-4" />,
                minSelection: 1,
                onExecute: async (rows: Row<TaskOut>[]) => {
                  setDueDateItems(rows.map((row) => row.original));
                  return { success: true };
                },
              },
            ]
          : []),
        ...(onCreateProject
          ? [
              {
                id: "create-project",
                label: "Create project from selected...",
                icon: <Sparkles className="size-4" />,
                minSelection: 1,
                onExecute: async (rows: Row<TaskOut>[]) => {
                  onCreateProject(rows.map((row) => row.original.id));
                  return { success: true };
                },
              },
            ]
          : []),
        ...extraActions,
      ],
      clearSelectionOnComplete: false,
    }),
    [extraActions, includeDueDate, onCreateProject],
  );

  return {
    config,
    moveItems,
    setMoveItems,
    statusItems,
    setStatusItems,
    tradeItems,
    setTradeItems,
    dueDateItems,
    setDueDateItems,
  };
}

export type TaskBulkActionsController = ReturnType<typeof useTaskBulkActions>;

export function TaskBulkActionDialogs({
  controller,
  onComplete,
}: {
  controller: TaskBulkActionsController;
  onComplete: () => void;
}) {
  const api = useTRPC();
  const {
    moveItems,
    setMoveItems,
    statusItems,
    setStatusItems,
    tradeItems,
    setTradeItems,
    dueDateItems,
    setDueDateItems,
  } = controller;
  const success =
    (verb: "Moved" | "Updated") =>
    (data: {
      items: unknown[];
      sideEffects: Parameters<typeof savedWithBackgroundWork>[0];
    }) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `${verb} ${data.items.length} task${data.items.length !== 1 ? "s" : ""}`,
      );

  const moveMutation = useActionMutation({
    mutationFn: api.task.bulkMove.mutationOptions,
    invalidateKeys: taskMutationInvalidateKeys,
    success: success("Moved"),
    onSuccess: () => {
      setMoveItems([]);
      onComplete();
    },
  });
  const statusMutation = useActionMutation({
    mutationFn: api.task.bulkSetStatus.mutationOptions,
    invalidateKeys: taskMutationInvalidateKeys,
    success: success("Updated"),
    onSuccess: () => {
      setStatusItems([]);
      onComplete();
    },
  });
  const tradeMutation = useActionMutation({
    mutationFn: api.task.bulkSetTrade.mutationOptions,
    invalidateKeys: taskMutationInvalidateKeys,
    success: success("Updated"),
    onSuccess: () => {
      setTradeItems([]);
      onComplete();
    },
  });
  const dueDateMutation = useActionMutation({
    mutationFn: api.task.bulkSetDueDate.mutationOptions,
    invalidateKeys: taskMutationInvalidateKeys,
    success: success("Updated"),
    onSuccess: () => {
      setDueDateItems([]);
      onComplete();
    },
  });

  return (
    <>
      {moveItems.length > 0 && (
        <MoveToProjectDialog
          open
          onOpenChange={(open) => {
            if (!open) setMoveItems([]);
          }}
          items={moveItems}
          entityLabel="Task"
          isPending={moveMutation.isPending}
          onConfirm={async (projectId) => {
            await moveMutation.mutateAsync({
              ids: moveItems.map((task) => task.id),
              projectId,
            });
          }}
        />
      )}
      {statusItems.length > 0 && (
        <SetTaskStatusDialog
          open
          onOpenChange={(open) => {
            if (!open) setStatusItems([]);
          }}
          items={statusItems}
          isPending={statusMutation.isPending}
          onConfirm={async (status) => {
            await statusMutation.mutateAsync({
              ids: statusItems.map((task) => task.id),
              status,
            });
          }}
        />
      )}
      {tradeItems.length > 0 && (
        <SetFieldDialog
          open
          onOpenChange={(open) => {
            if (!open) setTradeItems([]);
          }}
          items={tradeItems}
          isPending={tradeMutation.isPending}
          options={tradeOptions}
          fieldLabel="Trade"
          itemNoun="Task"
          onConfirm={async (trade) => {
            await tradeMutation.mutateAsync({
              ids: tradeItems.map((task) => task.id),
              trade: trade as Trade,
            });
          }}
        />
      )}
      {dueDateItems.length > 0 && (
        <SetDueDateDialog
          open
          onOpenChange={(open) => {
            if (!open) setDueDateItems([]);
          }}
          items={dueDateItems}
          isPending={dueDateMutation.isPending}
          onConfirm={async (dueDate, dueEndDate) => {
            await dueDateMutation.mutateAsync({
              ids: dueDateItems.map((task) => task.id),
              dueDate,
              dueEndDate,
            });
          }}
        />
      )}
    </>
  );
}
