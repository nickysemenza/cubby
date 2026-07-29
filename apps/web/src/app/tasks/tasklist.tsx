import type { TaskCompletion, TaskOut } from "@cubby/schemas/project";
import { createColumnHelper } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useMemo } from "react";
import {
  taskDueColumn,
  taskStatusColumn,
  taskTradeColumn,
} from "~/app/projects/shared";
import { usePageCount } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { useTRPC } from "~/integrations/trpc/react";
import { taskMutationInvalidateKeys } from "~/lib/query-keys";
import { createProjectLinkColumn } from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useProjectOptions } from "../_components/hooks/useProjectOptions";
import { useSeededFilter } from "../_components/hooks/useSeededFilter";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import {
  TaskBulkActionDialogs,
  useTaskBulkActions,
} from "../_components/tracker/task-bulk-actions";

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
  /**
   * Completion scope forwarded to `task.list`'s `completion` filter — undefined
   * keeps today's "all" default (the `/tasks?view=all` list). `/tasks?view=history`
   * passes `"done"` to scope this same table to completed tasks.
   */
  completion?: TaskCompletion;
}

export function TaskList({
  actions,
  initialSearch,
  completion,
}: TaskListProps) {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<TaskOut>(), []);
  const { options: projectOptions } = useProjectOptions();
  const taskBulkActions = useTaskBulkActions();

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

  // Runtime picklist for the manifest's `project` spec (optionsKey: "project").
  const projectFilterOptions = useFilterOptions({ project: projectOptions });

  // Scope constants that aren't column filters. Checklist subtasks are managed
  // from their parent's detail page, not surfaced as independent rows here.
  const taskScope = useMemo(
    () => ({ topLevelOnly: true, completion }),
    [completion],
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
    [columnHelper],
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
    totalCount,
  } = useEntityList({
    entity: "task",
    queryOptions: api.task.list.queryOptions,
    extraFilters: taskScope,
    filterOptions: projectFilterOptions,
    columns,
    deletable: deletableConfig,
    nameEditable,
    nameSuffix: subtaskCountSuffix,
    bulkActions: taskBulkActions.config,
    tableStateOptions,
  });
  usePageCount(totalCount);

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
      <TaskBulkActionDialogs
        controller={taskBulkActions}
        onComplete={() => table.resetRowSelection()}
      />
    </div>
  );
}
