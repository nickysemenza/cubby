import type { ProductWithFoodOut } from "@cubby/schemas/product";
import type { TaskOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { format } from "date-fns";
import type { FC } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import {
  TASK_STATUS_LABELS,
  taskStatusBadgeVariant,
} from "~/app/tasks/task-options";
import { Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useTRPC } from "~/integrations/trpc/react";
import { parsePlainDate } from "~/lib/plain-date";
import { ShelfEmpty } from "../data-table/shelf";

const EMPTY_TASKS: TaskOut[] = [];

const effectiveDueDate = (task: TaskOut) =>
  task.dueEndDate ?? task.dueDate ?? null;

/**
 * Open work leads the list by nearest due date. Completed work follows in
 * reverse chronology. Undated rows use creation time as their stable fallback.
 * Subtasks are intentionally included: the product is the subject of the work
 * regardless of whether the task is a top-level plan or a checklist step.
 */
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

export const ProductTaskHistory: FC<{ product: ProductWithFoodOut }> = ({
  product,
}) => {
  const api = useTRPC();
  const { data, isPending } = useQuery(
    api.task.chartData.queryOptions({ subjectProductId: product.id }),
  );
  const tasks = data ?? EMPTY_TASKS;

  if (isPending) {
    return <Description>Loading tasks…</Description>;
  }

  if (tasks.length === 0) {
    return (
      <ShelfEmpty
        entity="task"
        label="No tasks linked — add one to build this product's work history"
      />
    );
  }

  const ordered = orderProductTasks(tasks);

  return (
    <Stack gap="sm">
      <Table className="table-auto">
        <TableHeader>
          <TableRow>
            <TableHead>Task</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Project</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map((task) => {
            const dueDate = effectiveDueDate(task);
            return (
              <TableRow key={task.id}>
                <TableCell>
                  <EntityInlineLink entity="task" data={task} />
                </TableCell>
                <TableCell>
                  <Badge variant={taskStatusBadgeVariant[task.status]}>
                    {TASK_STATUS_LABELS[task.status]}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono tabular-nums">
                  {dueDate ? (
                    format(parsePlainDate(dueDate), "MMM d, yyyy")
                  ) : (
                    <NoneValue />
                  )}
                </TableCell>
                <TableCell>
                  {task.projectId && task.projectName ? (
                    <EntityInlineLink
                      entity="project"
                      data={{ id: task.projectId, name: task.projectName }}
                    />
                  ) : (
                    <NoneValue />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <Link
        to="/tasks"
        search={{ view: "all", productId: product.id }}
        className="text-primary text-xs hover:underline"
      >
        See all tasks →
      </Link>
    </Stack>
  );
};
