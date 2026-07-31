import type {
  ActionableTaskOut,
  ActionableTasksOut,
  BlockedTaskOut,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
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
import { TASK_STATUS_LABELS, taskStatusBadgeVariant } from "./task-options";

/** A single chain node (task or project) as a linked breadcrumb chip. */
function ChainNodeLink({
  node,
}: {
  node: {
    id: string;
    shortcode: string;
    name: string;
    type: "task" | "project";
  };
}) {
  return match(node.type)
    .with("task", () => (
      <EntityInlineLink
        entity="task"
        data={{ id: node.id, shortcode: node.shortcode, name: node.name }}
        compact
      />
    ))
    .with("project", () => (
      <EntityInlineLink
        entity="project"
        data={{ id: node.id, shortcode: node.shortcode, name: node.name }}
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

/**
 * Read-only, non-paginated, non-selectable rows — a static `<Table>` fits
 * this better than `<RTable>` (see CLAUDE.md's Tables guidance: `<RTable>`
 * would be overkill for a "here's your list" view). `next`/`later` arrive
 * pre-sorted server-side (`task.listActionable`), so this renders them as-is
 * — no client sort.
 */
function TaskRows({ rows }: { rows: ActionableTaskOut[] }) {
  return (
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
          <TableRow key={t.id}>
            <TableCell>
              <Row align="center" gap="xs">
                <EntityInlineLink
                  entity="task"
                  data={{ id: t.id, shortcode: t.shortcode, name: t.name }}
                  truncate
                />
                {t.subtaskCount > 0 && (
                  <Badge variant="outline">
                    {t.doneSubtaskCount}/{t.subtaskCount}
                  </Badge>
                )}
              </Row>
            </TableCell>
            <TableCell>
              <Badge variant={taskStatusBadgeVariant[t.status]}>
                {TASK_STATUS_LABELS[t.status]}
              </Badge>
            </TableCell>
            <TableCell>
              {t.projectId && t.projectName && t.projectShortcode ? (
                <EntityInlineLink
                  entity="project"
                  data={{
                    id: t.projectId,
                    shortcode: t.projectShortcode,
                    name: t.projectName,
                  }}
                  truncate
                />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell>{formatDateRange(t.dueDate, t.dueEndDate)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The `/tasks?view=next` surface: Next / Someday / Blocked, from `task.listActionable`. */
export function NextTasks() {
  const api = useTRPC();
  const { data, isLoading, isError, error, refetch } = useQuery(
    api.task.listActionable.queryOptions(),
  );

  if (isError) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyIcon icon={ListTodo} />
          <EmptyTitle>Couldn't load tasks</EmptyTitle>
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
    return <SimpleLoading text="Loading tasks..." />;
  }

  return <NextTasksBody data={data} />;
}

function NextTasksBody({ data }: { data: ActionableTasksOut }) {
  return (
    <Stack gap="lg">
      <Section title="Next" description="Unblocked tasks you can act on now.">
        {data.next.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing next right now — everything open is blocked or set aside.
          </p>
        ) : (
          <TaskRows rows={data.next} />
        )}
      </Section>

      {data.later.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-2 font-medium text-muted-foreground text-sm hover:text-foreground">
            Someday ({data.later.length})
          </summary>
          <div className="mt-2">
            <TaskRows rows={data.later} />
          </div>
        </details>
      )}

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
                    data={{
                      id: bt.task.id,
                      shortcode: bt.task.shortcode,
                      name: bt.task.name,
                    }}
                  />
                  <Badge variant={taskStatusBadgeVariant[bt.task.status]}>
                    {TASK_STATUS_LABELS[bt.task.status]}
                  </Badge>
                  {bt.task.subtaskCount > 0 && (
                    <Badge variant="outline">
                      {bt.task.doneSubtaskCount}/{bt.task.subtaskCount}
                    </Badge>
                  )}
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
