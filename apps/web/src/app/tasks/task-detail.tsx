import type { TaskOut, TaskStatus } from "@cubby/schemas/project";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Info, Link2 } from "lucide-react";
import type { FC } from "react";
import { useMemo } from "react";
import { WithTaskSearch } from "~/app/_components/combobox/with-search-hook";
import { formatDateRange } from "~/app/projects/shared";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { taskMutationInvalidateKeys } from "~/lib/query-keys";
import { DependencyPicker } from "../_components/data-table/dependency-picker";
import {
  type DetailHeroStat,
  type DetailSection,
  DetailSections,
} from "../_components/data-table/detail-page";
import { EditableCell } from "../_components/data-table/editable-cell";
import { useEntityDetail } from "../_components/hooks/useEntityDetail";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import {
  TASK_STATUS_LABELS,
  taskStatusBadgeVariant,
  taskStatusOptions,
} from "./task-options";

interface TaskDetailProps {
  task: TaskOut;
}

/** A blocked-by/blocking dependency link, name-only. */
function TaskDependencyBadge({ id, name }: { id: string; name: string }) {
  return (
    <Link to="/tasks/$id" params={{ id }}>
      <Badge variant="outline" className="cursor-pointer hover:bg-muted">
        {name}
      </Badge>
    </Link>
  );
}

export const TaskDetail: FC<TaskDetailProps> = ({ task }) => {
  const api = useTRPC();

  const updateMutation = useUpdateMutation({
    mutationFn: api.task.update.mutationOptions,
    entity: "task",
    invalidateKeys: taskMutationInvalidateKeys,
  });

  // Common sections from entity config (History) — editMode/mappings unused
  // here since Overview is edited via inline EditableCell fields, not a Form.
  const { commonSections } = useEntityDetail<TaskOut, never>({
    entity: "task",
    data: task,
    mutationOptions: api.task.update.mutationOptions(),
    invalidateKeys: taskMutationInvalidateKeys,
  });

  // Resolve blockedBy/blocking dependency ids into linked name badges via
  // per-id getByID queries (no batch-by-ids endpoint exists) — useQueries +
  // combine keeps the result referentially stable across renders.
  const depIds = useMemo(
    () => [...task.blockedByIds, ...task.blockingIds],
    [task.blockedByIds, task.blockingIds],
  );
  const depQueryOptions = useMemo(
    () => depIds.map((id) => api.task.getByID.queryOptions({ id })),
    [api, depIds],
  );
  const { depsById } = useQueries({
    queries: depQueryOptions,
    combine: (results) => ({
      depsById: new Map(
        results
          .map((r) => r.data)
          .filter((d): d is TaskOut => d != null)
          .map((d) => [d.id, d.name] as const),
      ),
    }),
  });
  const resolveDeps = (ids: TaskOut["blockedByIds"]) =>
    ids
      .map((id) => {
        const name = depsById.get(id);
        return name ? { id, name } : null;
      })
      .filter((d): d is NonNullable<typeof d> => d != null);
  const blockedBy = resolveDeps(task.blockedByIds);
  const blocking = resolveDeps(task.blockingIds);

  const fields: BasicInfoField[] = [
    {
      label: "Name",
      value: (
        <EditableCell
          value={task.name}
          config={{ type: "text" }}
          onSave={async (name) => {
            if (!name) return;
            await updateMutation.mutateAsync({ id: task.id, data: { name } });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Status",
      value: (
        <EditableCell
          value={task.status}
          config={{ type: "select", options: taskStatusOptions }}
          onSave={async (status) => {
            if (!status) return;
            await updateMutation.mutateAsync({
              id: task.id,
              data: { status: status as TaskStatus },
            });
          }}
          renderValue={(status) =>
            status ? (
              <Badge variant={taskStatusBadgeVariant[status as TaskStatus]}>
                {TASK_STATUS_LABELS[status as TaskStatus]}
              </Badge>
            ) : (
              <NoneValue />
            )
          }
        />
      ),
    },
    {
      label: "Category",
      value: (
        <EditableCell
          value={task.category}
          config={{ type: "text" }}
          onSave={async (category) => {
            await updateMutation.mutateAsync({
              id: task.id,
              data: { category },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Due date",
      value: (
        <EditableCell
          value={task.dueDate}
          config={{ type: "text", placeholder: "YYYY-MM-DD" }}
          onSave={async (dueDate) => {
            await updateMutation.mutateAsync({
              id: task.id,
              data: { dueDate },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Due end date",
      value: (
        <EditableCell
          value={task.dueEndDate}
          config={{ type: "text", placeholder: "YYYY-MM-DD" }}
          onSave={async (dueEndDate) => {
            await updateMutation.mutateAsync({
              id: task.id,
              data: { dueEndDate },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Project",
      value: task.projectId ? (
        <Link to="/projects/$id" params={{ id: task.projectId }}>
          <Badge variant="outline" className="cursor-pointer hover:bg-muted">
            {task.projectName}
          </Badge>
        </Link>
      ) : undefined,
    },
  ];

  const sections: DetailSection[] = [
    {
      title: "Overview",
      icon: Info,
      content: <BasicInfo fields={fields} />,
    },
    {
      title: "Dependencies",
      icon: Link2,
      content: (
        <Stack gap="sm">
          <Stack gap="xs">
            <p className="eyebrow my-0">Blocked by</p>
            <DependencyPicker
              value={blockedBy}
              onSave={async (ids) => {
                await updateMutation.mutateAsync({
                  id: task.id,
                  data: { blockedByIds: ids },
                });
              }}
              SearchProvider={WithTaskSearch}
              label="task"
              excludeId={task.id}
              renderReadChip={(item) => <TaskDependencyBadge {...item} />}
            />
          </Stack>
          {blocking.length > 0 && (
            <Stack gap="xs">
              <p className="eyebrow my-0">Blocks</p>
              <Row wrap gap="sm">
                {blocking.map((t) => (
                  <TaskDependencyBadge key={t.id} {...t} />
                ))}
              </Row>
            </Stack>
          )}
        </Stack>
      ),
    },
    ...commonSections,
  ];

  const heroStats: DetailHeroStat[] = [
    {
      label: "Category",
      value: task.category ?? <NoneValue />,
    },
    {
      label: "Due",
      value: formatDateRange(task.dueDate, task.dueEndDate),
    },
    {
      label: "Project",
      value: task.projectId ? (
        <Link to="/projects/$id" params={{ id: task.projectId }}>
          {task.projectName}
        </Link>
      ) : (
        <NoneValue />
      ),
    },
  ];

  return (
    <Page
      variant="detail"
      entity="task"
      title={task.name}
      rawData={task}
      heroStamp={{
        label: TASK_STATUS_LABELS[task.status],
        tone:
          task.status === "done"
            ? "green"
            : task.status === "blocked"
              ? "red"
              : "ink",
      }}
      heroStats={heroStats}
    >
      <DetailSections sections={sections} rawData={task} />
    </Page>
  );
};
