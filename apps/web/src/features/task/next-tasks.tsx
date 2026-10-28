import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { TaskFilters } from "@cubby/schemas/project";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { match } from "ts-pattern";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import {
  entityDisplayImageKey,
  type EntityDisplayImageMap,
  useEntityDisplayImages,
} from "~/entity/entity-media/entity-display-images";
import { useEntityMetadata } from "~/entity/metadata";
import { renderOptionCell } from "~/entity/table/column-helpers";
import { task } from "~/integrations/tanstack-query/generated/domains/task.gen";
import { DateDisplay } from "~/ui/common/date-display";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { SimpleLoading } from "~/ui/feedback/loading-skeletons";
import { Row, Section, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";
import { Badge } from "~/ui/primitives/badge";
import { StaticTable } from "~/ui/primitives/static-table";

type ActionableTasksOut = Awaited<ReturnType<typeof task.listActionable.call>>;
type ActionableTaskOut = ActionableTasksOut["next"][number];
type BlockedTaskOut = ActionableTasksOut["blocked"][number];

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
      entityDisplayImageKey({ entityKind: node.type, entityId: node.id })
    ] ?? null;
  return match(node.type)
    .with("task", () => (
      <EntityRefLink
        displayImage={displayImage}
        entity="task"
        data={{ id: node.id, name: node.name }}
      />
    ))
    .with("project", () => (
      <EntityRefLink
        displayImage={displayImage}
        entity="project"
        data={{ id: node.id, name: node.name }}
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

/** Actionable tasks arrive pre-sorted by task.listActionable; this report
 * preserves that server order without paging or client sorting. */
function TaskRows({
  rows,
  displayImages,
}: {
  rows: ActionableTaskOut[];
  displayImages: EntityDisplayImageMap;
}) {
  const queryClient = useQueryClient();
  useEntityMetadata("task");
  const statusOptions = useMemo(
    () => fieldEnumOptions(queryClient, "task", "status"),
    [queryClient],
  );
  return (
    <StaticTable
      rows={rows}
      rowKey={(t) => t.id}
      columns={[
        {
          id: "column-0",
          header: "Task",
          headClassName: "w-64",
          cell: (t) => (
            <Row align="center" gap="xs" className="min-w-0">
              <EntityRefLink
                displayImage={
                  displayImages[
                    entityDisplayImageKey({
                      entityKind: "task",
                      entityId: t.id,
                    })
                  ] ?? null
                }
                entity="task"
                data={{ id: t.id, name: t.name }}
              />
              {t.subtaskCount > 0 && (
                <Badge variant="outline">
                  {t.doneSubtaskCount}/{t.subtaskCount}
                </Badge>
              )}
            </Row>
          ),
        },
        {
          id: "column-1",
          header: "Status",
          headClassName: "w-32",
          cell: (t) => renderOptionCell(t.status, statusOptions),
        },
        {
          id: "column-2",
          header: "Project",
          headClassName: "w-40",
          cell: (t) => {
            const projectId = fieldValueOf(t.fields.projectId);
            return projectId && t.projectName ? (
              <EntityRefLink
                displayImage={
                  displayImages[
                    entityDisplayImageKey({
                      entityKind: "project",
                      entityId: projectId,
                    })
                  ] ?? null
                }
                entity="project"
                data={{
                  id: projectId,
                  name: t.projectName,
                }}
              />
            ) : (
              <span className="text-muted-foreground">—</span>
            );
          },
        },
        {
          id: "column-3",
          header: "Due",
          headClassName: "w-28",
          cell: (t) => (
            <DateDisplay
              start={t.due?.start ?? null}
              end={t.due?.end ?? null}
            />
          ),
        },
      ]}
    />
  );
}

/** The `/tasks?view=next` surface: Next / Someday / Blocked, from `task.listActionable`. */
export function NextTasks({ filters }: { filters: TaskFilters }) {
  const { data, isLoading, isError, error, refetch } = useQuery(
    task.listActionable.queryOptions(filters),
  );

  if (isError) {
    return (
      <ErrorDisplay
        error={error}
        title="tasks"
        onRetry={() => void refetch()}
      />
    );
  }

  if (isLoading || !data) {
    return <SimpleLoading text="Loading tasks..." />;
  }

  return <NextTasksBody data={data} />;
}

function NextTasksBody({ data }: { data: ActionableTasksOut }) {
  const queryClient = useQueryClient();
  useEntityMetadata("task");
  const statusOptions = useMemo(
    () => fieldEnumOptions(queryClient, "task", "status"),
    [queryClient],
  );
  const imageRefs = useMemo(
    () => [
      ...data.next.map((task) => ({
        entityKind: "task" as const,
        entityId: task.id,
      })),
      ...data.later.map((task) => ({
        entityKind: "task" as const,
        entityId: task.id,
      })),
      ...[...data.next, ...data.later].flatMap((task) => {
        const projectId = fieldValueOf(task.fields.projectId);
        return projectId
          ? [{ entityKind: "project" as const, entityId: projectId }]
          : [];
      }),
      ...data.blocked.flatMap((blocked) => [
        { entityKind: "task" as const, entityId: blocked.task.id },
        ...blocked.reasons.flatMap((reason) =>
          reason.kind !== "manual"
            ? reason.chain.map((node) => ({
                entityKind: node.type,
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
      <Section
        headingAs="h2"
        title="Next"
        caption="Unblocked tasks you can act on now."
      >
        {data.next.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing next right now — everything open is blocked or set aside.
          </p>
        ) : (
          <TaskRows rows={data.next} displayImages={displayImages} />
        )}
      </Section>

      {data.later.length > 0 && (
        <Disclosure summary="Someday" meta={data.later.length}>
          <TaskRows rows={data.later} displayImages={displayImages} />
        </Disclosure>
      )}

      <Section
        headingAs="h2"
        title="Blocked"
        caption="Open tasks waiting on something else, with the chain of why."
      >
        {data.blocked.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is blocked.</p>
        ) : (
          <Stack gap="md">
            {data.blocked.map((bt) => (
              <Stack key={bt.task.id} gap="xs">
                <Row gap="sm" align="center">
                  <EntityRefLink
                    displayImage={
                      displayImages[
                        entityDisplayImageKey({
                          entityKind: "task",
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
                  {renderOptionCell(bt.task.status, statusOptions)}
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
