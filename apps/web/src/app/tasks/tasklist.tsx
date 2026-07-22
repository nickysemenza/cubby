import { unsafeProjectId } from "@cubby/schemas/identifiers";
import type { TaskOut, TaskStatus, Trade } from "@cubby/schemas/project";
import type { Row } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import { ArrowRightLeft, ListChecks, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  taskDueColumn,
  taskStatusColumn,
  taskTradeColumn,
  tradeOptions,
} from "~/app/projects/shared";
import { Badge } from "~/components/ui/badge";
import { useTRPC } from "~/integrations/trpc/react";
import { taskMutationInvalidateKeys } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { createProjectLinkColumn } from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { useActionMutation } from "../_components/hooks/useActionMutation";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useProjectOptions } from "../_components/hooks/useProjectOptions";
import { useSeededFilter } from "../_components/hooks/useSeededFilter";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { MoveToProjectDialog } from "../_components/tracker/move-to-project-dialog";
import { SetFieldDialog } from "../_components/tracker/set-field-dialog";
import { SetTaskStatusDialog } from "../_components/tracker/set-task-status-dialog";
import {
  dueRangeOptions,
  resolveDueRange,
  taskStatusOptions,
} from "./task-options";

/**
 * `N/M` checklist chip after a parent task's name. Module-level because
 * `nameSuffix` sits in useStandardColumns' columns-`useMemo` dependency array
 * — an inline arrow would churn the memo every render.
 */
const subtaskCountSuffix = (row: TaskOut): ReactNode =>
  row.subtaskCount > 0 ? (
    <Badge variant="outline">
      {row.doneSubtaskCount}/{row.subtaskCount}
    </Badge>
  ) : undefined;

interface TaskListProps {
  /** Actions to display in the table toolbar (e.g., the "New Task" button). */
  actions?: ReactNode;
  /**
   * Seed the "name" column filter from the route's `q` search param (e.g. a
   * command-palette deep link). Only used on mount — typing in the search
   * box afterwards behaves normally and does not sync back to the URL.
   */
  initialSearch?: string;
}

export function TaskList({ actions, initialSearch }: TaskListProps) {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<TaskOut>(), []);
  const { options: projectOptions } = useProjectOptions();
  const [bulkMoveItems, setBulkMoveItems] = useState<TaskOut[]>([]);
  const [bulkStatusItems, setBulkStatusItems] = useState<TaskOut[]>([]);
  const [bulkTradeItems, setBulkTradeItems] = useState<TaskOut[]>([]);

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
          icon: <ArrowRightLeft className="h-4 w-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<TaskOut>[]) => {
            setBulkMoveItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
        {
          id: "set-status",
          label: "Set status...",
          icon: <ListChecks className="h-4 w-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<TaskOut>[]) => {
            setBulkStatusItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
        {
          id: "set-trade",
          label: "Set trade...",
          icon: <Wrench className="h-4 w-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<TaskOut>[]) => {
            setBulkTradeItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );

  const projectFilterOptions = useMemo(
    () => [{ value: "", label: "All projects" }, ...projectOptions],
    [projectOptions],
  );

  // The status / due / trade columns come from the shared factories in
  // `~/app/projects/shared.tsx`, also used by the embedded `TaskList` on the
  // project detail page — so the two can't drift. This page passes its own
  // mobile projections; the project + name columns stay inline here.
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
      createProjectLinkColumn(columnHelper, {
        className: "w-40",
        mobile: { slot: "meta", priority: 30, interactive: true },
        filterConfig: {
          placeholder: "Filter by project...",
          filterType: "select",
          options: projectFilterOptions,
        },
        editable: {
          onSave: async (newProjectId, task) => {
            await updateTaskMutation.mutateAsync({
              id: task.id,
              data: { projectId: newProjectId },
            });
          },
        },
      }),
      taskDueColumn(
        columnHelper,
        async (dueDate, task) => {
          await updateTaskMutation.mutateAsync({
            id: task.id,
            data: { dueDate },
          });
        },
        { mobile: { slot: "meta", priority: 40, interactive: true } },
      ),
      taskTradeColumn(
        columnHelper,
        async (trade, task) => {
          await updateTaskMutation.mutateAsync({
            id: task.id,
            data: { trade },
          });
        },
        { mobile: { slot: "meta", priority: 50 } },
      ),
    ],
    [columnHelper, projectFilterOptions],
  );

  const filters = useMemo(
    () => [
      { id: "name", placeholder: "Search tasks..." },
      {
        id: "status",
        placeholder: "Filter by status...",
        filterType: "select" as const,
        options: taskStatusOptions,
      },
      {
        id: "trade",
        placeholder: "Filter by trade...",
        filterType: "select" as const,
        options: tradeOptions,
      },
      {
        id: "due",
        placeholder: "Filter by due date...",
        filterType: "select" as const,
        options: dueRangeOptions,
      },
      {
        id: "project",
        placeholder: "Filter by project...",
        filterType: "select" as const,
        options: projectFilterOptions,
      },
    ],
    [projectFilterOptions],
  );

  const tableStateOptions = useSeededFilter("name", initialSearch);
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("task");

  const {
    table,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
  } = useEntityList({
    entity: "task",
    queryOptions: api.task.list.queryOptions,
    buildFilters: (ts) => {
      const projectFilter = ts.getColumnFilter("project");
      return {
        search: ts.getColumnFilter("name"),
        status: ts.getColumnFilter("status") as TaskStatus | undefined,
        trade: ts.getColumnFilter("trade") as Trade | undefined,
        projectId: projectFilter ? unsafeProjectId(projectFilter) : undefined,
        ...resolveDueRange(ts.getColumnFilter("due")),
        // Checklist subtasks are managed from their parent's detail page, not
        // surfaced as independent rows here.
        topLevelOnly: true,
      };
    },
    columns,
    filters,
    deletable: deletableConfig,
    nameEditable,
    nameSuffix: subtaskCountSuffix,
    bulkActions,
    infinite: true,
    tableStateOptions,
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

  return (
    <div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Tasks Table"
        timing={timing}
        entity="task"
        actions={actions}
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
      />
      <PreviewSheet />
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
    </div>
  );
}
