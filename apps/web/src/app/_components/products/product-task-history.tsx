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
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { useTRPC } from "~/integrations/trpc/react";
import { ShelfEmpty } from "../data-table/shelf";
import {
  createCubbyColumnHelper,
  useCubbyTable,
} from "../data-table/table-features";
import { useCubbyTableLayout } from "../data-table/table-layout";

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
  const api = useTRPC();
  const helper = useMemo(() => createCubbyColumnHelper<TaskOut>(), []);
  const { data, isPending } = useQuery(
    api.task.chartData.queryOptions({ subjectProductId: product.id }),
  );
  const tasks = data ?? EMPTY_TASKS;
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("task", "update"),
    entity: "task",
  });
  const nameEditable = useNameEditable<TaskOut>(update.mutateAsync);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mutation wrapper is functionally stable
  const columns = useMemo(
    () =>
      helper.columns([
        createNameColumn(helper, "task", "name", {
          header: "Task",
          editable: nameEditable,
        }),
        taskStatusColumn(helper, async (status, task) => {
          await update.mutateAsync({ id: task.id, data: { status } });
        }),
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
        createProjectLinkColumn(helper, {
          editable: {
            onSave: async (projectId, task) => {
              await update.mutateAsync({ id: task.id, data: { projectId } });
            },
          },
        }),
      ]),
    [helper, nameEditable],
  );
  const ordered = useMemo(() => orderProductTasks(tasks), [tasks]);
  const layout = useCubbyTableLayout({
    key: "task:product-history",
    columns,
  });
  const table = useCubbyTable({
    data: ordered,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
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
        className="text-primary text-xs hover:underline"
      >
        See all tasks →
      </Link>
    </Stack>
  );
};
