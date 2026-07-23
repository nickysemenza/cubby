import type { TaskId } from "@cubby/schemas/identifiers";
import type { TaskOut, Trade } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import type { Row } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import {
  ArrowRightLeft,
  CalendarClock,
  ListChecks,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  taskDueColumn,
  taskStatusColumn,
  taskTradeColumn,
  tradeOptions,
} from "~/app/projects/shared";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Badge } from "~/components/ui/badge";
import { useTRPC } from "~/integrations/trpc/react";
import { taskMutationInvalidateKeys } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import RTable from "../_components/data-table/Table";
import { useActionMutation } from "../_components/hooks/useActionMutation";
import { useClientEntityList } from "../_components/hooks/useClientEntityList";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { MoveToProjectDialog } from "../_components/tracker/move-to-project-dialog";
import { SetDueDateDialog } from "../_components/tracker/set-due-date-dialog";
import { SetFieldDialog } from "../_components/tracker/set-field-dialog";
import { SetTaskStatusDialog } from "../_components/tracker/set-task-status-dialog";
import { CreateProjectFromTasksDialog } from "./create-project-from-tasks-dialog";

/** Stable empty default — never a fresh `[]` per render (would churn memos). */
const NO_TASKS: TaskOut[] = [];

/**
 * `N/M` checklist chip after a parent task's name — mirrors tasklist.tsx's
 * `subtaskCountSuffix`. Module-level: a stable reference for the columns memo.
 */
const subtaskCountSuffix = (row: TaskOut): ReactNode =>
  row.subtaskCount > 0 ? (
    <Badge variant="outline">
      {row.doneSubtaskCount}/{row.subtaskCount}
    </Badge>
  ) : undefined;

/** Inbox is a triage queue, never large at single-user scale — one bounded page. */
const INBOX_PAGE_SIZE = 500;

/**
 * The `/tasks?view=inbox` surface: top-level, open tasks with no project — the
 * triage queue. Scoped server-side via `task.list`'s `noProject: true`
 * predicate (`projectId IS NULL`) — NOT `task.chartData`'s fetch-all — so this
 * view never pulls every open task in the household, only the inbox's own
 * (small) row set. Rendered through `useClientEntityList` (client-data table
 * — no UI pagination needed at inbox scale, but the fetch itself is bounded).
 */
export function TaskInbox() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<TaskOut>(), []);
  const [bulkMoveItems, setBulkMoveItems] = useState<TaskOut[]>([]);
  const [bulkStatusItems, setBulkStatusItems] = useState<TaskOut[]>([]);
  const [bulkTradeItems, setBulkTradeItems] = useState<TaskOut[]>([]);
  const [bulkDueDateItems, setBulkDueDateItems] = useState<TaskOut[]>([]);
  const [createProjectTaskIds, setCreateProjectTaskIds] = useState<
    TaskId[] | null
  >(null);

  // `completion: "open"` matches `task.summary`'s `inbox` count exactly
  // (topLevelOpen + projectId IS NULL) — the stat tile and this view agree.
  const { data, isLoading } = useQuery(
    api.task.list.queryOptions({
      filters: { topLevelOnly: true, completion: "open", noProject: true },
      pagination: { pageIndex: 0, pageSize: INBOX_PAGE_SIZE },
    }),
  );
  const inboxTasks = data?.items ?? NO_TASKS;

  const updateTaskMutation = useUpdateMutation({
    mutationFn: api.task.update.mutationOptions,
    entity: "task",
    invalidateKeys: taskMutationInvalidateKeys,
  });

  const nameEditable = useNameEditable<TaskOut>(updateTaskMutation.mutateAsync);

  const deletableConfig = useDeletableConfig({
    mutationFn: api.task.delete.mutationOptions,
    entityLabel: "Task",
    invalidateKeys: taskMutationInvalidateKeys,
  });

  const bulkActions = useMemo(
    () => ({
      actions: [
        {
          id: "move",
          label: "Move to project...",
          icon: <ArrowRightLeft className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<TaskOut>[]) => {
            setBulkMoveItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
        {
          id: "set-status",
          label: "Set status...",
          icon: <ListChecks className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<TaskOut>[]) => {
            setBulkStatusItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
        {
          id: "set-trade",
          label: "Set trade...",
          icon: <Wrench className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<TaskOut>[]) => {
            setBulkTradeItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
        {
          id: "set-due-date",
          label: "Set due date...",
          icon: <CalendarClock className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<TaskOut>[]) => {
            setBulkDueDateItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
        {
          id: "create-project",
          label: "Create project from selected...",
          icon: <Sparkles className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<TaskOut>[]) => {
            setCreateProjectTaskIds(rows.map((r) => r.original.id));
            return { success: true };
          },
        },
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateTaskMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      taskStatusColumn(
        columnHelper,
        async (status, task) => {
          await updateTaskMutation.mutateAsync({
            id: task.id,
            data: { status },
          });
        },
        { mobile: { slot: "subtitle", priority: 10 } },
      ),
      taskDueColumn(
        columnHelper,
        async (dueDate, task) => {
          await updateTaskMutation.mutateAsync({
            id: task.id,
            data: { dueDate },
          });
        },
        { mobile: { slot: "meta", priority: 30, interactive: true } },
      ),
      taskTradeColumn(
        columnHelper,
        async (trade, task) => {
          await updateTaskMutation.mutateAsync({
            id: task.id,
            data: { trade },
          });
        },
        { mobile: { slot: "meta", priority: 40 } },
      ),
    ],
    [columnHelper],
  );

  // Only the name box is a real `useStandardColumns` filter def (it feeds
  // the "name" column's search input) — status/trade already carry their own
  // working header filter via `createFilterableSelectColumn` inside
  // `taskStatusColumn`/`taskTradeColumn` above, independent of this list.
  const filters = useMemo(
    () => [{ id: "name", placeholder: "Search tasks..." }],
    [],
  );

  const { table, bulkActionBar, deleteDialog } = useClientEntityList({
    entity: "task",
    data: inboxTasks,
    columns,
    filters,
    deletable: deletableConfig,
    nameEditable,
    nameSuffix: subtaskCountSuffix,
    bulkActions,
  });

  const bulkMoveMutation = useActionMutation({
    mutationFn: api.task.bulkMove.mutationOptions,
    invalidateKeys: taskMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Moved ${data.items.length} task${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkMoveItems([]);
      table.resetRowSelection();
    },
  });

  const bulkStatusMutation = useActionMutation({
    mutationFn: api.task.bulkSetStatus.mutationOptions,
    invalidateKeys: taskMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Updated ${data.items.length} task${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkStatusItems([]);
      table.resetRowSelection();
    },
  });

  const bulkTradeMutation = useActionMutation({
    mutationFn: api.task.bulkSetTrade.mutationOptions,
    invalidateKeys: taskMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Updated ${data.items.length} task${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkTradeItems([]);
      table.resetRowSelection();
    },
  });

  const bulkDueDateMutation = useActionMutation({
    mutationFn: api.task.bulkSetDueDate.mutationOptions,
    invalidateKeys: taskMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Updated ${data.items.length} task${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkDueDateItems([]);
      table.resetRowSelection();
    },
  });

  if (isLoading) {
    return <SimpleLoading text="Loading inbox..." />;
  }

  return (
    <div>
      <RTable
        table={table}
        ariaLabel="Inbox Tasks Table"
        entity="task"
        bulkActionBar={bulkActionBar}
      />
      {deleteDialog}
      {bulkMoveItems.length > 0 && (
        <MoveToProjectDialog
          open={bulkMoveItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkMoveItems([]);
          }}
          items={bulkMoveItems}
          entityLabel="Task"
          isPending={bulkMoveMutation.isPending}
          onConfirm={async (projectId) => {
            await bulkMoveMutation.mutateAsync({
              ids: bulkMoveItems.map((t) => t.id),
              projectId,
            });
          }}
        />
      )}
      {bulkStatusItems.length > 0 && (
        <SetTaskStatusDialog
          open={bulkStatusItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkStatusItems([]);
          }}
          items={bulkStatusItems}
          isPending={bulkStatusMutation.isPending}
          onConfirm={async (status) => {
            await bulkStatusMutation.mutateAsync({
              ids: bulkStatusItems.map((t) => t.id),
              status,
            });
          }}
        />
      )}
      {bulkTradeItems.length > 0 && (
        <SetFieldDialog
          open={bulkTradeItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkTradeItems([]);
          }}
          items={bulkTradeItems}
          isPending={bulkTradeMutation.isPending}
          options={tradeOptions}
          fieldLabel="Trade"
          itemNoun="Task"
          onConfirm={async (trade) => {
            await bulkTradeMutation.mutateAsync({
              ids: bulkTradeItems.map((t) => t.id),
              trade: trade as Trade,
            });
          }}
        />
      )}
      {bulkDueDateItems.length > 0 && (
        <SetDueDateDialog
          open={bulkDueDateItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkDueDateItems([]);
          }}
          items={bulkDueDateItems}
          isPending={bulkDueDateMutation.isPending}
          onConfirm={async (dueDate, dueEndDate) => {
            await bulkDueDateMutation.mutateAsync({
              ids: bulkDueDateItems.map((t) => t.id),
              dueDate,
              dueEndDate,
            });
          }}
        />
      )}
      {createProjectTaskIds && (
        <CreateProjectFromTasksDialog
          open={createProjectTaskIds !== null}
          onOpenChange={(open) => {
            if (!open) setCreateProjectTaskIds(null);
          }}
          taskIds={createProjectTaskIds}
        />
      )}
    </div>
  );
}
