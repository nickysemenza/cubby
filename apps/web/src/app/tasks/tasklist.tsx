import { unsafeProjectId } from "@cubby/schemas/identifiers";
import type { TaskOut, TaskStatus } from "@cubby/schemas/project";
import { createColumnHelper } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Badge } from "~/components/ui/badge";
import { useTRPC } from "~/integrations/trpc/react";
import { taskMutationInvalidateKeys } from "~/lib/query-keys";
import {
  createFilterableSelectColumn,
  createPlainDateColumn,
  createProjectLinkColumn,
  createTextColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useProjectOptions } from "../_components/hooks/useProjectOptions";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import {
  taskStatusBadgeVariant,
  taskStatusLabels,
  taskStatusOptions,
} from "./task-options";

interface TaskListProps {
  /** Actions to display in the table toolbar (e.g., the "New Task" button). */
  actions?: ReactNode;
}

export function TaskList({ actions }: TaskListProps) {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<TaskOut>(), []);
  const { options: projectOptions } = useProjectOptions();

  const updateTaskMutation = useUpdateMutation({
    mutationFn: api.task.update.mutationOptions,
    entity: "task",
    invalidateKeys: taskMutationInvalidateKeys,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateTaskMutation changes every render but is functionally stable
  const nameEditable = useMemo(
    () => ({
      onSave: async (newName: string, task: TaskOut) => {
        await updateTaskMutation.mutateAsync({
          id: task.id,
          data: { name: newName },
        });
      },
    }),
    [],
  );

  const deletableConfig = useDeletableConfig({
    mutationFn: api.task.delete.mutationOptions,
    entityLabel: "Task",
    invalidateKeys: taskMutationInvalidateKeys,
  });

  const projectFilterOptions = useMemo(
    () => [{ value: "", label: "All projects" }, ...projectOptions],
    [projectOptions],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateTaskMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      createFilterableSelectColumn(columnHelper, "status", {
        header: "Status",
        className: "w-32",
        placeholder: "Filter by status...",
        selectOptions: taskStatusOptions,
        renderCell: (status: TaskStatus) => (
          <Badge variant={taskStatusBadgeVariant[status]}>
            {taskStatusLabels[status]}
          </Badge>
        ),
        mobile: { slot: "subtitle", priority: 10 },
        editable: {
          onSave: async (newStatus, task) => {
            await updateTaskMutation.mutateAsync({
              id: task.id,
              data: { status: newStatus },
            });
          },
        },
      }),
      createProjectLinkColumn(columnHelper, {
        className: "w-40",
        mobile: { slot: "meta", priority: 30, interactive: true },
        filterConfig: {
          placeholder: "Filter by project...",
          filterType: "select",
          options: projectFilterOptions,
        },
      }),
      createPlainDateColumn(columnHelper, "dueDate", {
        header: "Due",
        className: "w-28",
        mobile: { slot: "meta", priority: 40 },
      }),
      createTextColumn(columnHelper, "category", {
        header: "Category",
        className: "min-w-0 w-32 truncate",
        mobile: { slot: "meta", priority: 50 },
        editable: {
          onSave: async (newValue, task) => {
            await updateTaskMutation.mutateAsync({
              id: task.id,
              data: { category: newValue },
            });
          },
        },
      }),
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
        id: "project",
        placeholder: "Filter by project...",
        filterType: "select" as const,
        options: projectFilterOptions,
      },
    ],
    [projectFilterOptions],
  );

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
        projectId: projectFilter ? unsafeProjectId(projectFilter) : undefined,
      };
    },
    columns,
    filters,
    deletable: deletableConfig,
    nameEditable,
    infinite: true,
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
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
      />
      {deleteDialog}
    </div>
  );
}
