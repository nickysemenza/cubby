import type { TaskOut } from "@cubby/schemas/project";
import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";

import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import {
  taskDueColumn,
  taskStatusColumn,
  taskTradeColumn,
} from "~/app/projects/shared";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { manifestFilterConfig } from "~/entities/filter-manifest";

import {
  createParentLinkColumn,
  createProjectLinkColumn,
  createSubjectProductLinkColumn,
} from "../_components/data-table/columnHelpers";
import { EntityListPage } from "../_components/data-table/EntityListPage";
import { ScopeChip } from "../_components/data-table/ScopeChip";
import { useDeferredFilterOptions } from "../_components/hooks/useDeferredFilterOptions";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useSeededFilter } from "../_components/hooks/useSeededFilter";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";

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

const tasksRoute = getRouteApi("/_authenticated/tasks/");
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
  const columnHelper = useMemo(() => createCubbyColumnHelper<TaskOut>(), []);
  const projectOptions = useDeferredFilterOptions("project");
  const productOptions = useDeferredFilterOptions("product");

  const updateTaskMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("task", "update"),
    entity: "task",
  });

  const nameEditable = useNameEditable<TaskOut>(updateTaskMutation.mutateAsync);

  // Runtime picklist for the manifest's `project` spec (optionsKey: "project").
  const parentOptions = useDeferredFilterOptions("task");
  const projectFilterOptions = useFilterOptions({
    project: projectOptions,
    taskProducts: productOptions,
    parentTask: parentOptions,
  });

  // The status / due / trade columns come from the shared factories in
  // `~/app/projects/shared.tsx`, also used by the embedded `TaskList` on the
  // project detail page — so the two can't drift. This page passes its own
  // mobile projections; the project + name columns stay inline here.
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
      createSubjectProductLinkColumn(columnHelper, {
        className: "w-40",
        mobile: { slot: "meta", priority: 35, interactive: true },
        editable: {
          onSave: async (subjectProductId, task) => {
            await updateTaskMutation.mutateAsync({
              id: task.id,
              data: { subjectProductId },
            });
          },
        },
      }),
      createParentLinkColumn(
        columnHelper,
        "task",
        "parentTaskId",
        "parentTaskName",
        {
          filterConfig: manifestFilterConfig("task", "parentTask", {
            parentTask: parentOptions,
          }),
        },
      ),
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
    // oxlint-disable-next-line react/exhaustive-deps -- The mutation wrapper changes identity while its operation contract remains stable.
    [columnHelper, parentOptions],
  );

  const tableStateOptions = useSeededFilter("name", initialSearch);

  // Exact product scopes arrive from a product detail page and do not belong
  // to TanStack column state. Keep the scope visible and independently
  // clearable, matching the expense ledger's product deep link.
  const tasksSearch = tasksRoute.useSearch();
  const tasksNavigate = tasksRoute.useNavigate();
  const scopedProductId = tasksSearch.productId;
  const hasInvalidProductScope = scopedProductId === UNRESOLVABLE_ENTITY_FILTER;
  const scopedProductQuery = useQuery({
    ...entityDetailFor("product").queryOptions(scopedProductId ?? ""),
    enabled: Boolean(scopedProductId) && !hasInvalidProductScope,
  });
  const clearProductScope = useCallback(() => {
    void tasksNavigate({
      search: (prev) => ({ ...prev, productId: undefined }),
      replace: true,
    });
  }, [tasksNavigate]);
  const toolbarActions =
    scopedProductId && (hasInvalidProductScope || scopedProductQuery.data) ? (
      <Row gap="sm" align="center">
        <ScopeChip
          name="Product"
          value={scopedProductQuery.data?.name ?? scopedProductId}
          onClear={clearProductScope}
        />
        {actions}
      </Row>
    ) : (
      actions
    );

  return (
    <EntityListPage
      entity="task"
      filterOptions={projectFilterOptions}
      columns={columns}
      nameEditable={nameEditable}
      nameSuffix={subtaskCountSuffix}
      tableStateOptions={tableStateOptions}
      ariaLabel="Tasks Table"
      actions={toolbarActions}
    />
  );
}
