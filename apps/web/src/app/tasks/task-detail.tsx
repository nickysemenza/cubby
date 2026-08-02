import type {
  ProductShortcode,
  ProjectShortcode,
} from "@cubby/schemas/identifiers";
import type { TaskOut, TaskStatus, Trade } from "@cubby/schemas/project";
import { useQueries, useQuery } from "@tanstack/react-query";
import { CalendarPlus, Info, Link2, ListChecks } from "lucide-react";
import type { FC } from "react";
import { useMemo, useState } from "react";
import {
  WithProductSearch,
  WithProjectSearch,
  WithTaskSearch,
} from "~/app/_components/combobox/with-search-hook";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import {
  formatDateRange,
  TradeBadge,
  tradeOptions,
} from "~/app/projects/shared";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row, Stack } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { taskMutationInvalidateKeys } from "~/lib/query-keys";
import { DependencyPicker } from "../_components/data-table/dependency-picker";
import {
  type DetailSection,
  DetailSections,
} from "../_components/data-table/detail-page";
import { EditableCell } from "../_components/data-table/editable-cell";
import { EditableEntityCell } from "../_components/data-table/editable-entity-cell";
import { useActionMutation } from "../_components/hooks/useActionMutation";
import { useEntityDelete } from "../_components/hooks/useEntityDelete";
import { useEntityDetail } from "../_components/hooks/useEntityDetail";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { CreateTaskDialog } from "./create-task-dialog";
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
  return <EntityInlineLink entity="task" data={{ id, name }} compact />;
}

// Stable empty array — see CLAUDE.md's "unstable-hook-default" guard: an
// inline `[]` here would allocate a fresh reference on every render while
// the subtasks query is loading/disabled.
const NO_SUBTASKS: TaskOut[] = [];

const SUBTASKS_PAGINATION = { pageIndex: 0, pageSize: 200 } as const;
const SUBTASKS_SORT = { orderBy: "createdAt", direction: "asc" } as const;

/**
 * The parent's checklist: live subtasks with a checkbox toggling
 * done <-> not_started, a link to each subtask's own detail page, and an
 * inline quick-add. Parent status stays fully manual — completing every
 * subtask here never touches the parent's own status.
 */
function SubtaskChecklist({ task }: { task: TaskOut }) {
  const api = useTRPC();
  const [newSubtaskName, setNewSubtaskName] = useState("");

  const { data: subtasksPage } = useQuery(
    api.task.list.queryOptions({
      filters: { parentTaskId: task.id },
      sort: SUBTASKS_SORT,
      pagination: SUBTASKS_PAGINATION,
    }),
  );
  const subtasks = subtasksPage?.items ?? NO_SUBTASKS;

  // This is its own component (not threaded TaskDetail's `updateMutation`
  // prop), so it gets its own instance of the same "any field update"
  // mutation the rest of the page's EditableCells use — same
  // `taskMutationInvalidateKeys`, so toggling here also refreshes the
  // parent's own subtaskCount/doneSubtaskCount.
  const toggleMutation = useUpdateMutation({
    mutationFn: api.task.update.mutationOptions,
    entity: "task",
    invalidateKeys: taskMutationInvalidateKeys,
  });

  const createMutation = useActionMutation({
    mutationFn: api.task.create.mutationOptions,
    invalidateKeys: taskMutationInvalidateKeys,
    success: (created) => `Added "${created.name}"`,
    onSuccess: () => setNewSubtaskName(""),
  });

  const addSubtask = () => {
    const name = newSubtaskName.trim();
    if (!name) return;
    // Subtasks inherit the parent's trade (like projectId, one-time at create).
    createMutation.mutate({ name, parentTaskId: task.id, trade: task.trade });
  };

  return (
    <Stack gap="sm">
      {subtasks.length === 0 ? (
        <p className="text-muted-foreground text-sm">No subtasks yet.</p>
      ) : (
        <Stack gap="xs">
          {subtasks.map((subtask) => (
            <Row key={subtask.id} align="center" gap="sm">
              <Checkbox
                checked={subtask.status === "done"}
                disabled={toggleMutation.isPending}
                onCheckedChange={(checked) =>
                  toggleMutation.mutate({
                    id: subtask.id,
                    data: { status: checked ? "done" : "not_started" },
                  })
                }
              />
              <EntityInlineLink
                entity="task"
                data={{
                  id: subtask.id,
                  name: subtask.name,
                }}
                compact
              />
            </Row>
          ))}
        </Stack>
      )}
      <Row gap="sm" align="center">
        <Input
          value={newSubtaskName}
          onChange={(e) => setNewSubtaskName(e.target.value)}
          placeholder="Add a subtask..."
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addSubtask();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!newSubtaskName.trim() || createMutation.isPending}
          onClick={addSubtask}
        >
          Add
        </Button>
      </Row>
    </Stack>
  );
}

export const TaskDetail: FC<TaskDetailProps> = ({ task }) => {
  const api = useTRPC();
  const [followUpOpen, setFollowUpOpen] = useState(false);

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

  // `deleteTasks` also soft-deletes live subtasks and hard-deletes this task's
  // dependency edges (server/repo/task/crud.ts) — neither is visible from the
  // generic dialog copy, so spell the cascade out.
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: task.id,
    name: task.name,
    entityLabel: "Task",
    entity: "task",
    mutationOptions: (callbacks) => api.task.delete.mutationOptions(callbacks),
    invalidateKeys: taskMutationInvalidateKeys,
    redirectTo: "/tasks",
    description: `${
      task.subtaskCount > 0
        ? `This also deletes ${task.subtaskCount} subtask${task.subtaskCount === 1 ? "" : "s"}, and removes`
        : "This also removes"
    } the task from any dependency chains. This action cannot be undone.`,
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
          .map((d) => [d.id, { name: d.name }] as const),
      ),
    }),
  });
  const resolveDeps = (ids: TaskOut["blockedByIds"]) =>
    ids
      .map((id) => {
        const dep = depsById.get(id);
        return dep ? { id, name: dep.name } : null;
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
      label: "Trade",
      value: (
        <EditableCell
          value={task.trade}
          config={{ type: "select", options: tradeOptions }}
          onSave={async (trade) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!trade) return;
            await updateMutation.mutateAsync({
              id: task.id,
              data: { trade: trade as Trade },
            });
          }}
          renderValue={(v) =>
            v ? <TradeBadge trade={v as Trade} /> : <NoneValue />
          }
        />
      ),
    },
    {
      label: "Due date",
      value: (
        <EditableCell
          value={task.dueDate}
          config={{ type: "date" }}
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
          config={{ type: "date" }}
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
      value: (
        <EditableEntityCell<ProjectShortcode>
          value={
            task.projectId && task.projectName
              ? {
                  id: task.projectId,
                  name: task.projectName,
                }
              : null
          }
          label="project"
          clearable
          trigger="pencil"
          onSave={async (projectId) => {
            await updateMutation.mutateAsync({
              id: task.id,
              data: { projectId },
            });
          }}
          SearchProvider={WithProjectSearch}
          renderValue={(value) =>
            value && task.projectId && value.id === task.projectId ? (
              <EntityInlineLink
                entity="project"
                data={{
                  id: task.projectId,
                  name: value.name,
                }}
                compact
              />
            ) : value ? (
              <span>{value.name}</span>
            ) : (
              <NoneValue />
            )
          }
        />
      ),
    },
    {
      label: "For",
      value: (
        <EditableEntityCell<ProductShortcode>
          value={
            task.subjectProductId && task.subjectProductName
              ? {
                  id: task.subjectProductId,
                  name: task.subjectProductName,
                }
              : null
          }
          label="product"
          clearable
          trigger="pencil"
          onSave={async (subjectProductId) => {
            await updateMutation.mutateAsync({
              id: task.id,
              data: { subjectProductId },
            });
          }}
          SearchProvider={WithProductSearch}
          renderValue={(value) =>
            value &&
            task.subjectProductId &&
            value.id === task.subjectProductId ? (
              <EntityInlineLink
                entity="product"
                data={{
                  id: task.subjectProductId,
                  name: value.name,
                }}
              />
            ) : value ? (
              <span>{value.name}</span>
            ) : (
              <NoneValue />
            )
          }
        />
      ),
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
              renderReadChip={(item) => {
                return depsById.has(item.id) ? (
                  <TaskDependencyBadge id={item.id} name={item.name} />
                ) : null;
              }}
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
    // Subtasks only apply to a top-level task — a subtask itself never gets
    // its own checklist (one level only; see repo/task/crud.ts).
    ...(task.parentTaskId
      ? []
      : [
          {
            title: "Subtasks",
            icon: ListChecks,
            headerAction:
              task.subtaskCount > 0 ? (
                <Badge variant="outline">
                  {task.doneSubtaskCount}/{task.subtaskCount}
                </Badge>
              ) : undefined,
            content: <SubtaskChecklist task={task} />,
          } satisfies DetailSection,
        ]),
    ...commonSections,
  ];

  const heroStats: DetailHeroStat[] = [
    // A subtask surfaces its parent right in the spec-plate header (in place
    // of "Project" — a subtask inherits its project from the parent, not
    // independently, so the parent link is the more useful breadcrumb here).
    ...(task.parentTaskId && task.parentTaskName && task.parentTaskId
      ? [
          {
            label: "Subtask of",
            value: (
              <EntityInlineLink
                entity="task"
                data={{
                  id: task.parentTaskId,
                  name: task.parentTaskName,
                }}
                truncate
              />
            ),
          } satisfies DetailHeroStat,
        ]
      : []),
    {
      label: "Trade",
      value: task.trade ? <TradeBadge trade={task.trade} /> : <NoneValue />,
    },
    {
      label: "Due",
      value: formatDateRange(task.dueDate, task.dueEndDate),
    },
    {
      label: "Project",
      value:
        task.projectId && task.projectName && task.projectId ? (
          <EntityInlineLink
            entity="project"
            data={{
              id: task.projectId,
              name: task.projectName,
            }}
            truncate
          />
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
      actions={
        <Row gap="sm">
          <Button variant="outline" onClick={() => setFollowUpOpen(true)}>
            <CalendarPlus />
            Schedule follow-up
          </Button>
          {deleteButton}
        </Row>
      }
    >
      <DetailSections sections={sections} rawData={task} />
      <CreateTaskDialog
        open={followUpOpen}
        onOpenChange={setFollowUpOpen}
        presetName={task.name}
        presetProjectId={task.projectId}
        presetTrade={task.trade}
        presetSubjectProductId={task.subjectProductId}
        presetSubjectProductName={task.subjectProductName}
      />
      {deleteDialog}
    </Page>
  );
};
