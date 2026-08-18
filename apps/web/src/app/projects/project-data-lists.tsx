import type {
  EmbeddedProjectScope,
  ExpenseFilters,
  ExpenseOut,
  TaskFilters,
  TaskOut,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  createParentLinkColumn,
  createProductLinkColumn,
  createProjectLinkColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import {
  ExpenseBulkActionDialogs,
  useExpenseBulkActions,
} from "~/app/_components/tracker/expense-bulk-actions";
import {
  TaskBulkActionDialogs,
  useTaskBulkActions,
} from "~/app/_components/tracker/task-bulk-actions";
import {
  expenseCostColumn,
  expenseDateColumn,
  expenseFutureColumn,
  expenseTradeColumn,
  taskDueColumn,
  taskStatusColumn,
  taskTradeColumn,
} from "~/app/projects/shared";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { useTRPC } from "~/integrations/trpc/react";
import {
  expenseMutationInvalidateKeys,
  taskMutationInvalidateKeys,
} from "~/lib/query-keys";

const EMBEDDED_TABLE_STATE = {
  urlSync: false,
  readUrlState: false,
} as const;

/**
 * Server-backed task list for Projects > Data. `projectScope` is contextual:
 * its presence requires a live matching project, so unassigned tasks never
 * leak into the table and membership is never reconstructed in the browser.
 */
export function ProjectDataTaskList({
  projectScope,
}: {
  projectScope: EmbeddedProjectScope;
}) {
  const api = useTRPC();
  const helper = useMemo(() => createCubbyColumnHelper<TaskOut>(), []);
  const { options: projectOptions } = useProjectOptions();
  const parentOptionsQuery = useQuery(
    api.task.list.queryOptions({
      filters: {},
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 500 },
    }),
  );
  const parentOptions = useMemo(
    () =>
      parentOptionsQuery.data?.items.map(({ id, name }) => ({
        value: id,
        label: name,
      })) ?? [],
    [parentOptionsQuery.data],
  );
  const filterOptions = useFilterOptions({
    project: projectOptions,
    parentTask: parentOptions,
  });
  const update = useUpdateMutation({
    mutationFn: api.task.update.mutationOptions,
    entity: "task",
    invalidateKeys: taskMutationInvalidateKeys,
  });
  const nameEditable = useNameEditable<TaskOut>(update.mutateAsync);
  const deletable = useDeletableConfig({
    mutationFn: api.task.delete.mutationOptions,
    entityLabel: "Task",
    invalidateKeys: taskMutationInvalidateKeys,
    entity: "task",
  });
  const bulk = useTaskBulkActions({ includeDueDate: true });
  const scopeFilters = useMemo<TaskFilters>(
    () => ({ projectScope }),
    [projectScope],
  );
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("task");

  // biome-ignore lint/correctness/useExhaustiveDependencies: mutation wrapper is functionally stable
  const columns = useMemo(
    () => [
      taskStatusColumn(helper, async (status, row) => {
        await update.mutateAsync({ id: row.id, data: { status } });
      }),
      createProjectLinkColumn(helper, {
        editable: {
          onSave: async (projectId, row) => {
            await update.mutateAsync({ id: row.id, data: { projectId } });
          },
        },
      }),
      createParentLinkColumn(helper, "task", "parentTaskId", "parentTaskName", {
        filterConfig: manifestFilterConfig("task", "parentTask", {
          parentTask: parentOptions,
        }),
      }),
      taskDueColumn(helper, async (dueDate, row) => {
        await update.mutateAsync({ id: row.id, data: { dueDate } });
      }),
      taskTradeColumn(helper, async (trade, row) => {
        await update.mutateAsync({ id: row.id, data: { trade } });
      }),
    ],
    [helper, parentOptions],
  );

  const list = useEntityList<TaskOut, TaskFilters>({
    entity: "task",
    queryOptions: api.task.list.queryOptions,
    scopeFilters,
    columns,
    filterOptions,
    deletable,
    nameEditable,
    bulkActions: bulk.config,
    tableStateOptions: EMBEDDED_TABLE_STATE,
    columnVisibilityScope: "projects-data",
  });

  return (
    <>
      <RTable
        table={list.table}
        isLoading={list.isLoading}
        error={list.error}
        ariaLabel="Project-scoped Tasks Table"
        timing={list.timing}
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        bulkActionBar={list.bulkActionBar}
        infiniteScroll={list.infiniteScroll}
        refreshControls={list.refreshControls}
      />
      <PreviewSheet />
      {list.deleteDialog}
      <TaskBulkActionDialogs
        controller={bulk}
        onComplete={() => list.table.resetRowSelection()}
      />
    </>
  );
}

/** Server-backed expense list with the same contextual project predicate. */
export function ProjectDataExpenseList({
  projectScope,
}: {
  projectScope: EmbeddedProjectScope;
}) {
  const api = useTRPC();
  const helper = useMemo(() => createCubbyColumnHelper<ExpenseOut>(), []);
  const { options: projectOptions } = useProjectOptions();
  const filterOptions = useFilterOptions({ project: projectOptions });
  const update = useUpdateMutation({
    mutationFn: api.expense.update.mutationOptions,
    entity: "expense",
    invalidateKeys: expenseMutationInvalidateKeys,
  });
  const nameEditable = useNameEditable<ExpenseOut>(update.mutateAsync);
  const deletable = useDeletableConfig({
    mutationFn: api.expense.delete.mutationOptions,
    entityLabel: "Expense",
    invalidateKeys: expenseMutationInvalidateKeys,
    entity: "expense",
  });
  const bulk = useExpenseBulkActions();
  const scopeFilters = useMemo<ExpenseFilters>(
    () => ({ projectScope }),
    [projectScope],
  );
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("expense");

  // biome-ignore lint/correctness/useExhaustiveDependencies: mutation wrapper is functionally stable
  const columns = useMemo(
    () => [
      expenseCostColumn(helper, async (cost, row) => {
        await update.mutateAsync({ id: row.id, data: { cost } });
      }),
      expenseDateColumn(helper, async (date, row) => {
        if (date !== null)
          await update.mutateAsync({ id: row.id, data: { date } });
      }),
      expenseTradeColumn(helper, async (trade, row) => {
        await update.mutateAsync({ id: row.id, data: { trade } });
      }),
      createProjectLinkColumn(helper, {
        editable: {
          onSave: async (projectId, row) => {
            await update.mutateAsync({ id: row.id, data: { projectId } });
          },
        },
      }),
      createProductLinkColumn(helper, {
        editable: {
          onSave: async (productId, row) => {
            await update.mutateAsync({ id: row.id, data: { productId } });
          },
        },
      }),
      expenseFutureColumn(helper, async (future, row) => {
        await update.mutateAsync({ id: row.id, data: { future } });
      }),
    ],
    [helper],
  );

  const list = useEntityList<ExpenseOut, ExpenseFilters>({
    entity: "expense",
    queryOptions: api.expense.list.queryOptions,
    scopeFilters,
    columns,
    filterOptions,
    deletable,
    nameEditable,
    bulkActions: bulk.config,
    tableStateOptions: EMBEDDED_TABLE_STATE,
    columnVisibilityScope: "projects-data",
  });

  return (
    <>
      <RTable
        table={list.table}
        isLoading={list.isLoading}
        error={list.error}
        ariaLabel="Project-scoped Expenses Table"
        timing={list.timing}
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        bulkActionBar={list.bulkActionBar}
        infiniteScroll={list.infiniteScroll}
        refreshControls={list.refreshControls}
      />
      <PreviewSheet />
      {list.deleteDialog}
      <ExpenseBulkActionDialogs
        controller={bulk}
        onComplete={() => list.table.resetRowSelection()}
      />
    </>
  );
}
