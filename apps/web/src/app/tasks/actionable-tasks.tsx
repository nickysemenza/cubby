import type {
  ActionableTaskOut,
  ActionableTasksOut,
  BlockedTaskOut,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { partition } from "es-toolkit";
import { ListTodo } from "lucide-react";
import { match } from "ts-pattern";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { formatDateRange } from "~/app/projects/shared";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Section, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";
import { TASK_STATUS_LABELS, taskStatusBadgeVariant } from "./task-options";

/** dueDate ascending, nulls last — mirrors the dashboard TaskList's sort. */
function byDueDateAsc(a: ActionableTaskOut, b: ActionableTaskOut) {
  if (!a.dueDate && !b.dueDate) return 0;
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  return a.dueDate.localeCompare(b.dueDate);
}

/** Non-later rows (sorted by due date) first, later rows (also sorted) last. */
function sortActionableRows(
  actionable: ActionableTaskOut[],
): ActionableTaskOut[] {
  const [later, dueSoon] = partition(actionable, (t) => t.isLater);
  return [...dueSoon.sort(byDueDateAsc), ...later.sort(byDueDateAsc)];
}

/** A single chain node (task or project) as a linked breadcrumb chip. */
function ChainNodeLink({
  node,
}: {
  node: { id: string; name: string; type: "task" | "project" };
}) {
  return match(node.type)
    .with("task", () => (
      <EntityInlineLink
        entity="task"
        data={{ id: node.id, name: node.name }}
        compact
      />
    ))
    .with("project", () => (
      <EntityInlineLink
        entity="project"
        data={{ id: node.id, name: node.name }}
        compact
      />
    ))
    .exhaustive();
}

/** One blocked reason: a "marked blocked" badge (manual) or a chain of breadcrumb chips. */
function BlockedReasonChips({
  reason,
}: {
  reason: BlockedTaskOut["reasons"][number];
}) {
  if (reason.kind === "manual") {
    return <Badge variant="destructive">marked blocked</Badge>;
  }
  return (
    <Row gap="xs" align="center" wrap>
      {reason.chain.map((node, i) => (
        <Row key={`${node.type}:${node.id}`} gap="xs" align="center">
          {i > 0 && <span className="text-muted-foreground">→</span>}
          <ChainNodeLink node={node} />
        </Row>
      ))}
    </Row>
  );
}

export function ActionableTasks() {
  const api = useTRPC();
  const { data, isLoading, isError, error, refetch } = useQuery(
    api.task.listActionable.queryOptions(),
  );

  if (isError) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyIcon icon={ListTodo} />
          <EmptyTitle>Couldn't load actionable tasks</EmptyTitle>
          <EmptyDescription>{getErrorMessage(error)}</EmptyDescription>
        </EmptyHeader>
        <EmptyActions>
          <Button type="button" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </EmptyActions>
      </Empty>
    );
  }

  if (isLoading || !data) {
    return <SimpleLoading text="Loading actionable tasks..." />;
  }

  return <ActionableTasksBody data={data} />;
}

function ActionableTasksBody({ data }: { data: ActionableTasksOut }) {
  const rows = sortActionableRows(data.actionable);

  return (
    <Stack gap="lg">
      <Section
        title="Actionable"
        description="Unblocked tasks you can act on now."
      >
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing actionable right now — everything open is blocked.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="w-40">Project</TableHead>
                <TableHead className="w-28">Due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow
                  key={t.id}
                  className={cn(t.isLater && "text-muted-foreground")}
                >
                  <TableCell>
                    <EntityInlineLink
                      entity="task"
                      data={{ id: t.id, name: t.name }}
                      truncate
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant={taskStatusBadgeVariant[t.status]}>
                      {TASK_STATUS_LABELS[t.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {t.projectId && t.projectName ? (
                      <EntityInlineLink
                        entity="project"
                        data={{ id: t.projectId, name: t.projectName }}
                        truncate
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {formatDateRange(t.dueDate, t.dueEndDate)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title="Blocked"
        description="Open tasks waiting on something else, with the chain of why."
      >
        {data.blocked.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing is blocked.</p>
        ) : (
          <Stack gap="md">
            {data.blocked.map((bt) => (
              <Stack key={bt.task.id} gap="xs">
                <Row gap="sm" align="center">
                  <EntityInlineLink
                    entity="task"
                    data={{ id: bt.task.id, name: bt.task.name }}
                  />
                  <Badge variant={taskStatusBadgeVariant[bt.task.status]}>
                    {TASK_STATUS_LABELS[bt.task.status]}
                  </Badge>
                </Row>
                <Stack gap="tight" className="pl-6">
                  {bt.reasons.map((reason, i) => (
                    <BlockedReasonChips
                      key={`${reason.kind}-${reason.chain[0]?.id ?? i}`}
                      reason={reason}
                    />
                  ))}
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}
      </Section>
    </Stack>
  );
}
