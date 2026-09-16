import type {
  EmbeddedProjectScope,
  ExpenseFilters,
  ExpenseOut,
  TaskFilters,
  TaskOut,
} from "@cubby/schemas/project";
import { useCallback, useMemo } from "react";

import {
  createParentLinkColumn,
  createProductLinkColumn,
  createProjectLinkColumn,
} from "~/app/_components/data-table/columnHelpers";
import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { useDeferredFilterOptions } from "~/app/_components/hooks/useDeferredFilterOptions";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import {
  expenseCostColumn,
  expenseDateColumn,
  expenseFutureColumn,
  expenseTradeColumn,
  taskDueColumn,
  taskStatusColumn,
  taskTradeColumn,
} from "~/app/projects/shared";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListFor } from "~/entities/entity-list.functions";
import { manifestFilterConfig } from "~/entities/filter-manifest";

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
  const listQueryOptions: ListQueryOptionsFn<TaskFilters, TaskOut> =
    useCallback((params) => entityListFor("task").listQueryPlan(params), []);
  const helper = useMemo(() => createCubbyColumnHelper<TaskOut>(), []);
  const projectOptions = useDeferredFilterOptions("project");
  const parentOptions = useDeferredFilterOptions("task");
  const filterOptions = useFilterOptions({
    project: projectOptions,
    parentTask: parentOptions,
  });
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("task", "update"),
    entity: "task",
  });
  const nameEditable = useNameEditable<TaskOut>(update.mutateAsync);
  const deletable = useDeletableConfig({
    mutationFn: entityMutationOptionsFactory("task", "delete"),
    entityLabel: "Task",
    entity: "task",
  });
  const scopeFilters = useMemo<TaskFilters>(
    () => ({ projectScope }),
    [projectScope],
  );
  const { onRowClick, onRowHover, onRowHoverEnd, PreviewSheet } =
    useEntityPreview("task");

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<TaskOut>((add) => {
        add(
          taskStatusColumn(helper, async (status, row) => {
            await update.mutateAsync({ id: row.id, data: { status } });
          }),
        );
        add(
          createProjectLinkColumn(helper, {
            editable: {
              onSave: async (projectId, row) => {
                await update.mutateAsync({ id: row.id, data: { projectId } });
              },
            },
          }),
        );
        add(
          createParentLinkColumn(
            helper,
            "task",
            "parentTaskId",
            "parentTaskName",
            {
              filterConfig: manifestFilterConfig("task", "parentTask", {
                parentTask: parentOptions,
              }),
            },
          ),
        );
        add(
          taskDueColumn(helper, async (dueDate, row) => {
            await update.mutateAsync({ id: row.id, data: { dueDate } });
          }),
        );
        add(
          taskTradeColumn(helper, async (trade, row) => {
            await update.mutateAsync({ id: row.id, data: { trade } });
          }),
        );
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- mutation wrapper is functionally stable
    [helper, parentOptions],
  );

  const list = useEntityList<TaskOut, TaskFilters>({
    entity: "task",
    queryOptions: listQueryOptions,
    scopeFilters,
    columns,
    filterOptions,
    deletable,
    nameEditable,
    tableStateOptions: EMBEDDED_TABLE_STATE,
  });

  return (
    <>
      <ListWorkbench
        model={list.workbench}
        ariaLabel="Project-scoped Tasks Table"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        onRowHoverEnd={onRowHoverEnd}
      />
      <PreviewSheet />
    </>
  );
}

/** Server-backed expense list with the same contextual project predicate. */
export function ProjectDataExpenseList({
  projectScope,
}: {
  projectScope: EmbeddedProjectScope;
}) {
  const listQueryOptions: ListQueryOptionsFn<ExpenseFilters, ExpenseOut> =
    useCallback((params) => entityListFor("expense").listQueryPlan(params), []);
  const helper = useMemo(() => createCubbyColumnHelper<ExpenseOut>(), []);
  const projectOptions = useDeferredFilterOptions("project");
  const filterOptions = useFilterOptions({ project: projectOptions });
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("expense", "update"),
    entity: "expense",
  });
  const nameEditable = useNameEditable<ExpenseOut>(update.mutateAsync);
  const deletable = useDeletableConfig({
    mutationFn: entityMutationOptionsFactory("expense", "delete"),
    entityLabel: "Expense",
    entity: "expense",
  });
  const scopeFilters = useMemo<ExpenseFilters>(
    () => ({ projectScope }),
    [projectScope],
  );
  const { onRowClick, onRowHover, onRowHoverEnd, PreviewSheet } =
    useEntityPreview("expense");

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<ExpenseOut>((add) => {
        add(
          expenseCostColumn(helper, async (cost, row) => {
            await update.mutateAsync({ id: row.id, data: { cost } });
          }),
        );
        add(
          expenseDateColumn(helper, async (date, row) => {
            if (date !== null)
              await update.mutateAsync({ id: row.id, data: { date } });
          }),
        );
        add(
          expenseTradeColumn(helper, async (trade, row) => {
            await update.mutateAsync({ id: row.id, data: { trade } });
          }),
        );
        add(
          createProjectLinkColumn(helper, {
            editable: {
              onSave: async (projectId, row) => {
                await update.mutateAsync({ id: row.id, data: { projectId } });
              },
            },
          }),
        );
        add(
          createProductLinkColumn(helper, {
            editable: {
              onSave: async (productId, row) => {
                await update.mutateAsync({ id: row.id, data: { productId } });
              },
            },
          }),
        );
        add(
          expenseFutureColumn(helper, async (future, row) => {
            await update.mutateAsync({ id: row.id, data: { future } });
          }),
        );
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- mutation wrapper is functionally stable
    [helper],
  );

  // The Data view spans several projects, so a move is a real relocation
  // rather than a no-op — but the moved row leaves this scoped table on success.
  const list = useEntityList<ExpenseOut, ExpenseFilters>({
    entity: "expense",
    queryOptions: listQueryOptions,
    scopeFilters,
    columns,
    filterOptions,
    deletable,
    nameEditable,
    tableStateOptions: EMBEDDED_TABLE_STATE,
  });

  return (
    <>
      <ListWorkbench
        model={list.workbench}
        ariaLabel="Project-scoped Expenses Table"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        onRowHoverEnd={onRowHoverEnd}
      />
      <PreviewSheet />
    </>
  );
}
