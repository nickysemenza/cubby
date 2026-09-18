import type {
  ActionableTaskOut,
  ActionableTasksOut,
  BlockedTaskOut,
  TaskFilters,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { ListTodo } from "lucide-react";
import { useMemo } from "react";
import { match } from "ts-pattern";

import {
  entityDisplayImageKey,
  type EntityDisplayImageMap,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
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
import { getErrorMessage } from "~/lib/error-utils";

import { TASK_STATUS_LABELS, taskStatusBadgeVariant } from "./task-options";
import { task } from "./task.functions";

/** A single chain node (task or project) as a linked breadcrumb chip. */
function ChainNodeLink({
  node,
  displayImages,
}: {
  // A blocked-reason chain node names its entity by public id only — `id` IS
  // the shortcode, so it serves both the link target and the preview fetch.
  node: {
    id: string;
    name: string;
    type: "task" | "project";
  };
  displayImages: EntityDisplayImageMap;
}) {
  const displayImage =
    displayImages[
      entityDisplayImageKey({ entityType: node.type, entityId: node.id })
    ] ?? null;
  return match(node.type)
    .with("task", () => (
      <EntityInlineLink
        displayImage={displayImage}
        entity="task"
        data={{ id: node.id, name: node.name }}
        compact
      />
    ))
    .with("project", () => (
      <EntityInlineLink
        displayImage={displayImage}
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
  displayImages,
}: {
  reason: BlockedTaskOut["reasons"][number];
  displayImages: EntityDisplayImageMap;
}) {
  if (reason.kind === "manual") {
    return <Badge variant="destructive">marked blocked</Badge>;
  }
  return (
    <Row gap="xs" align="center" wrap>
      {reason.chain.map((node, i) => (
        <Row key={`${node.type}:${node.id}`} gap="xs" align="center">
          {i > 0 && <span className="text-muted-foreground">→</span>}
          <ChainNodeLink node={node} displayImages={displayImages} />
        </Row>
      ))}
    </Row>
  );
}

/**
 * Read-only, non-paginated, non-selectable rows — a static `<Table>` fits
 * this better than `<RTable>` (see AGENTS.md's Tables guidance: `<RTable>`
 * would be overkill for a "here's your list" view). `next`/`later` arrive
 * pre-sorted server-side (`task.listActionable`), so this renders them as-is
 * — no client sort.
 */
function TaskRows({
  rows,
  displayImages,
}: {
  rows: ActionableTaskOut[];
  displayImages: EntityDisplayImageMap;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-64">Task</TableHead>
          <TableHead className="w-32">Status</TableHead>
          <TableHead className="w-40">Project</TableHead>
          <TableHead className="w-28">Due</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((t) => (
          <TableRow key={t.id}>
            <TableCell>
              <Row align="center" gap="xs" className="min-w-0">
                <EntityInlineLink
                  displayImage={
                    displayImages[
                      entityDisplayImageKey({
                        entityType: "task",
                        entityId: t.id,
                      })
                    ] ?? null
                  }
                  entity="task"
                  data={{ id: t.id, name: t.name }}
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
              {t.projectId && t.projectName && t.projectId ? (
                <EntityInlineLink
                  displayImage={
                    displayImages[
                      entityDisplayImageKey({
                        entityType: "project",
                        entityId: t.projectId,
                      })
                    ] ?? null
                  }
                  entity="project"
                  data={{
                    id: t.projectId,
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
export function NextTasks({ filters }: { filters: TaskFilters }) {
  const { data, isLoading, isError, error, refetch } = useQuery(
    task.listActionable.queryOptions(filters),
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
  const imageRefs = useMemo(
    () => [
      ...data.next.map((task) => ({
        entityType: "task" as const,
        entityId: task.id,
      })),
      ...data.later.map((task) => ({
        entityType: "task" as const,
        entityId: task.id,
      })),
      ...data.next.flatMap((task) =>
        task.projectId
          ? [{ entityType: "project" as const, entityId: task.projectId }]
          : [],
      ),
      ...data.later.flatMap((task) =>
        task.projectId
          ? [{ entityType: "project" as const, entityId: task.projectId }]
          : [],
      ),
      ...data.blocked.flatMap((blocked) => [
        { entityType: "task" as const, entityId: blocked.task.id },
        ...blocked.reasons.flatMap((reason) =>
          reason.kind !== "manual"
            ? reason.chain.map((node) => ({
                entityType: node.type,
                entityId: node.id,
              }))
            : [],
        ),
      ]),
    ],
    [data],
  );
  const displayImages = useEntityDisplayImages(imageRefs);

  return (
    <Stack gap="lg">
      <p className="text-xs text-muted-foreground">
        Next is an actionable-work renderer: it includes open top-level tasks
        and explains blockers. Compatible project, trade, search, and due-date
        filters are applied by the server.
      </p>
      <Section title="Next" description="Unblocked tasks you can act on now.">
        {data.next.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing next right now — everything open is blocked or set aside.
          </p>
        ) : (
          <TaskRows rows={data.next} displayImages={displayImages} />
        )}
      </Section>

      {data.later.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
            Someday ({data.later.length})
          </summary>
          <div className="mt-2">
            <TaskRows rows={data.later} displayImages={displayImages} />
          </div>
        </details>
      )}

      <Section
        title="Blocked"
        description="Open tasks waiting on something else, with the chain of why."
      >
        {data.blocked.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is blocked.</p>
        ) : (
          <Stack gap="md">
            {data.blocked.map((bt) => (
              <Stack key={bt.task.id} gap="xs">
                <Row gap="sm" align="center">
                  <EntityInlineLink
                    displayImage={
                      displayImages[
                        entityDisplayImageKey({
                          entityType: "task",
                          entityId: bt.task.id,
                        })
                      ] ?? null
                    }
                    entity="task"
                    data={{
                      id: bt.task.id,
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
                      displayImages={displayImages}
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
