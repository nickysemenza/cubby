import type { ProductWithFoodOut } from "@cubby/schemas/product";
import type { TaskOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FC, useMemo } from "react";

import {
  createNameColumn,
  createProjectLinkColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { taskDueColumn, taskStatusColumn } from "~/app/projects/shared";
import { task } from "~/app/tasks/task.functions";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";

import { useTableColumnLayout } from "../data-table/column-layout";
import { ShelfEmpty } from "../data-table/shelf";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "../data-table/table-features";

const EMPTY_TASKS: TaskOut[] = [];

const effectiveDueDate = (task: TaskOut) =>
  task.dueEndDate ?? task.dueDate ?? null;

/** Open work leads by due date; completed work follows in reverse chronology. */
export function orderProductTasks(tasks: TaskOut[]): TaskOut[] {
  return [...tasks].sort((left, right) => {
    const leftDone = left.status === "done";
    const rightDone = right.status === "done";
    if (leftDone !== rightDone) return leftDone ? 1 : -1;
    const leftDue = effectiveDueDate(left);
    const rightDue = effectiveDueDate(right);
    if (leftDue && rightDue) {
      return leftDone
        ? rightDue.localeCompare(leftDue)
        : leftDue.localeCompare(rightDue);
    }
    if (leftDue !== rightDue) return leftDue ? -1 : 1;
    return right.createdAt.getTime() - left.createdAt.getTime();
  });
}

/** Product-scoped task history; its own direct fields remain editable. */
export const ProductTaskHistory: FC<{ product: ProductWithFoodOut }> = ({
  product,
}) => {
  const helper = useMemo(() => createCubbyColumnHelper<TaskOut>(), []);
  const { data, isPending } = useQuery(
    task.chartData.queryOptions({ subjectProductId: product.id }),
  );
  const tasks = data ?? EMPTY_TASKS;
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("task", "update"),
    entity: "task",
  });
  const nameEditable = useNameEditable<TaskOut>(update.mutateAsync);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<TaskOut>((add) => {
        add(
          createNameColumn(helper, "task", "name", {
            header: "Task",
            editable: nameEditable,
          }),
        );
        add(
          taskStatusColumn(helper, async (status, task) => {
            await update.mutateAsync({ id: task.id, data: { status } });
          }),
        );
        add(
          taskDueColumn(
            helper,
            async (dueDate, task, field) => {
              await update.mutateAsync({
                id: task.id,
                data: { [field]: dueDate },
              });
            },
            { effective: true },
          ),
        );
        add(
          createProjectLinkColumn(helper, {
            editable: {
              onSave: async (projectId, task) => {
                await update.mutateAsync({ id: task.id, data: { projectId } });
              },
            },
          }),
        );
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- mutation wrapper is functionally stable
    [helper, nameEditable],
  );
  const ordered = useMemo(() => orderProductTasks(tasks), [tasks]);
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const table = useCubbyTable({
    data: ordered,
    columns: tableColumns,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
    meta: { defaultLayout },
    getRowId: (task) => task.id,
  });

  if (isPending) return <Description>Loading tasks…</Description>;
  if (tasks.length === 0) {
    return (
      <ShelfEmpty
        entity="task"
        label="No tasks linked — add one to build this product's work history"
      />
    );
  }

  return (
    <Stack gap="sm">
      <RTable
        table={table}
        ariaLabel={`${product.name} task history`}
        embedded
      />
      <Link
        to="/tasks"
        search={{ view: "list", productId: product.id }}
        className="text-xs text-primary hover:underline"
      >
        See all tasks →
      </Link>
    </Stack>
  );
};
