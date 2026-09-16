import type {
  ProductShortcode,
  ProjectShortcode,
} from "@cubby/schemas/identifiers";
import {
  taskStatusSchema,
  tradeSchema,
  type TaskOut,
} from "@cubby/schemas/project";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { CalendarPlus, ImageIcon, Info, Link2, ListChecks } from "lucide-react";
import type { FC } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { formatDateRange, tradeOptions } from "~/app/projects/shared";
import { Row, Stack } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { Input } from "~/components/ui/input";
import { NoneValue } from "~/components/ui/none-value";
import { taskCaptureRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { EntityBasicInfo } from "~/entities/entity-display";
import { entityListFor } from "~/entities/entity-list.functions";
import type { EntityDetailByEntity } from "~/entities/generated/entity-details.gen";
import { getErrorMessage } from "~/lib/error-utils";
import { patchListItem } from "~/lib/optimistic-list";

import { DependencyPicker } from "../_components/data-table/dependency-picker";
import {
  type DetailSection,
  DetailSections,
} from "../_components/data-table/detail-page";
import { EditableCell } from "../_components/data-table/editable-cell";
import { EditableEntityCell } from "../_components/data-table/editable-entity-cell";
import { useEntityDetail } from "../_components/hooks/useEntityDetail";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { EntityPhotosSection } from "../_components/photos/entity-photos-section";
import {
  TASK_STATUS_LABELS,
  taskStatusBadgeVariant,
  taskStatusOptions,
} from "./task-options";

interface TaskDetailProps {
  record: TaskOut;
}

/** A blocked-by/blocking dependency link, name-only. */
function TaskDependencyBadge({ id, name }: { id: string; name: string }) {
  return (
    <EntityInlineLink
      displayImage={undefined}
      entity="task"
      data={{ id, name }}
      compact
    />
  );
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
  const queryClient = useQueryClient();
  const [newSubtaskName, setNewSubtaskName] = useState("");
  const [pendingSubtaskName, setPendingSubtaskName] = useState<string | null>(
    null,
  );

  const subtasksOptions = entityListFor("task").queryOptions({
    filters: { parentTaskId: task.id },
    sort: SUBTASKS_SORT,
    pagination: SUBTASKS_PAGINATION,
  });
  const { data: subtasksPage } = useQuery(subtasksOptions);
  const subtasks = subtasksPage?.items ?? NO_SUBTASKS;

  const subtasksKey = subtasksOptions.queryKey;

  // Keep this deliberately narrow: this checkbox owns one exact checklist
  // query, so its update never blocks or patches the rest of the detail page.
  const toggleBase = entityMutationOptionsFactory("task", "update")();
  const toggleMutation = useMutation({
    ...toggleBase,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: subtasksKey });
      const previous =
        queryClient.getQueryData<typeof subtasksPage>(subtasksKey);
      queryClient.setQueryData<typeof subtasksPage>(
        subtasksKey,
        // Annotated: the updater input is NoInfer-wrapped, which would stop
        // patchListItem inferring the page type and drop `meta` from the result.
        (current: typeof subtasksPage) =>
          patchListItem(current, String(variables.id), (item: TaskOut) => ({
            ...item,
            status: variables.data.status ?? item.status,
            updatedAt: new Date(),
          })),
      );
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(subtasksKey, context.previous);
      }
      toast.error(getErrorMessage(error));
    },
  });

  const createBase = entityMutationOptionsFactory("task", "create")();
  const createMutation = useMutation({
    ...createBase,
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: subtasksKey });
      const previous =
        queryClient.getQueryData<typeof subtasksPage>(subtasksKey);
      const name = newSubtaskName.trim();
      setNewSubtaskName("");
      setPendingSubtaskName(name);
      return { name, previous };
    },
    onSuccess: (created) => {
      queryClient.setQueryData<typeof subtasksPage>(subtasksKey, (current) =>
        current
          ? {
              ...current,
              // A fresh subtask has no photos; the list row's server-resolved
              // `displayImages` is empty until the next refetch.
              items: [...current.items, { ...created, displayImages: [] }],
              meta: {
                ...current.meta,
                totalCount: current.meta.totalCount + 1,
              },
            }
          : current,
      );
      toast.success(`Added "${created.name}"`);
    },
    onError: (error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(subtasksKey, context.previous);
      }
      setNewSubtaskName(context?.name ?? "");
      toast.error(getErrorMessage(error));
    },
    onSettled: () => {
      setPendingSubtaskName(null);
    },
  });

  const addSubtask = () => {
    const name = newSubtaskName.trim();
    if (!name) return;
    // Subtasks inherit the parent's trade (like projectId, one-time at create).
    createMutation.mutate({ name, parentTaskId: task.id, trade: task.trade });
  };

  return (
    <Stack gap="sm">
      {subtasks.length === 0 && !pendingSubtaskName ? (
        <p className="text-sm text-muted-foreground">No subtasks yet.</p>
      ) : (
        <Stack gap="xs">
          {subtasks.map((subtask) => (
            <Row key={subtask.id} align="center" gap="sm">
              <Checkbox
                checked={subtask.status === "done"}
                disabled={
                  toggleMutation.isPending &&
                  toggleMutation.variables?.id === subtask.id
                }
                onCheckedChange={(checked) =>
                  toggleMutation.mutate({
                    id: subtask.id,
                    data: { status: checked ? "done" : "not_started" },
                  })
                }
              />
              <EntityInlineLink
                displayImage={undefined}
                entity="task"
                data={{
                  id: subtask.id,
                  name: subtask.name,
                }}
                compact
              />
            </Row>
          ))}
          {pendingSubtaskName && (
            <Row align="center" gap="sm" className="opacity-60">
              <Checkbox checked={false} disabled aria-label="Adding subtask" />
              <span className="text-sm">{pendingSubtaskName}</span>
            </Row>
          )}
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

export const TaskDetail: FC<TaskDetailProps> = ({ record: task }) => {
  const [followUpOpen, setFollowUpOpen] = useState(false);

  const updateMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("task", "update"),
    entity: "task",
  });

  // Common sections from entity config (History) — editMode/mappings unused
  // here since Overview is edited via inline EditableCell fields, not a Form.
  const { commonSections } = useEntityDetail<"task", TaskOut, never>({
    entity: "task",
    data: task,
  });

  // Resolve blockedBy/blocking dependency ids into linked name badges via
  // per-id getByID queries (no batch-by-ids endpoint exists) — useQueries +
  // combine keeps the result referentially stable across renders.
  const depIds = useMemo(
    () => [...task.blockedByIds, ...task.blockingIds],
    [task.blockedByIds, task.blockingIds],
  );
  const depQueryOptions = useMemo(
    () => depIds.map((id) => entityDetailFor("task").queryOptions(id)),
    [depIds],
  );
  const { depsById } = useQueries({
    queries: depQueryOptions,
    combine: (results) => ({
      depsById: new Map(
        results
          .map((r) => r.data)
          .filter((d): d is EntityDetailByEntity["task"] => d != null)
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

  const overrides = {
    name: () => ({
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
    }),
    status: () => ({
      value: (
        <EditableCell
          value={task.status}
          config={{ type: "select", options: taskStatusOptions }}
          onSave={async (status) => {
            const parsedStatus = taskStatusSchema.safeParse(status);
            if (!parsedStatus.success) return;
            await updateMutation.mutateAsync({
              id: task.id,
              data: { status: parsedStatus.data },
            });
          }}
          renderValue={(status) => {
            const parsedStatus = taskStatusSchema.safeParse(status);
            return parsedStatus.success ? (
              <Badge variant={taskStatusBadgeVariant[parsedStatus.data]}>
                {TASK_STATUS_LABELS[parsedStatus.data]}
              </Badge>
            ) : (
              <NoneValue />
            );
          }}
        />
      ),
      filterAction: (
        <EntityFilterLink
          to="/tasks"
          search={{ view: "list", status: task.status }}
          label={`Show all ${TASK_STATUS_LABELS[task.status].toLowerCase()} tasks`}
        />
      ),
    }),
    trade: () => ({
      value: (
        <EditableCell
          value={task.trade}
          config={{ type: "select", options: tradeOptions }}
          onSave={async (trade) => {
            // Required field — a cleared select is a no-op, not a null write.
            const parsedTrade = tradeSchema.safeParse(trade);
            if (!parsedTrade.success) return;
            await updateMutation.mutateAsync({
              id: task.id,
              data: { trade: parsedTrade.data },
            });
          }}
          renderValue={(v) => renderOptionCell(v, tradeOptions)}
        />
      ),
      filterAction: (
        <EntityFilterLink
          to="/tasks"
          search={{ view: "list", trade: task.trade }}
          label={`Show all tasks for trade ${task.trade}`}
        />
      ),
    }),
    dueDate: () => ({
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
    }),
    dueEndDate: () => ({
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
    }),
    projectId: () => ({
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
          SearchProvider={(props) => (
            <WithEntitySearch entity="project" {...props} />
          )}
          renderValue={(value) =>
            value && task.projectId && value.id === task.projectId ? (
              <EntityInlineLink
                displayImage={undefined}
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
      filterAction: task.projectId ? (
        <EntityFilterLink
          to="/tasks"
          search={{ view: "list", project: task.projectId }}
          label={`Show all tasks in ${task.projectName ?? "this project"}`}
        />
      ) : undefined,
    }),
    subjectProductId: () => ({
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
          SearchProvider={(props) => (
            <WithEntitySearch entity="product" {...props} />
          )}
          renderValue={(value) =>
            value &&
            task.subjectProductId &&
            value.id === task.subjectProductId ? (
              <EntityInlineLink
                displayImage={undefined}
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
      filterAction: task.subjectProductId ? (
        <EntityFilterLink
          to="/tasks"
          search={{ view: "list", productId: task.subjectProductId }}
          label={`Show all tasks for ${task.subjectProductName ?? "this product"}`}
        />
      ) : undefined,
    }),
  };

  const sections: DetailSection[] = [
    {
      id: "overview",
      title: "Overview",
      icon: Info,
      placement: "primary",
      content: (
        <EntityBasicInfo entity="task" record={task} overrides={overrides} />
      ),
    },
    {
      id: "dependencies",
      title: "Dependencies",
      icon: Link2,
      placement: "supporting",
      content: (
        <Stack gap="sm">
          <Stack gap="xs">
            <p className="my-0 eyebrow">Blocked by</p>
            <DependencyPicker
              value={blockedBy}
              onSave={async (ids) => {
                await updateMutation.mutateAsync({
                  id: task.id,
                  data: { blockedByIds: ids },
                });
              }}
              SearchProvider={(props) => (
                <WithEntitySearch entity="task" {...props} />
              )}
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
              <p className="my-0 eyebrow">Blocks</p>
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
            id: "subtasks",
            title: "Subtasks",
            icon: ListChecks,
            placement: "primary",
            headerAction:
              task.subtaskCount > 0 ? (
                <Badge variant="outline">
                  {task.doneSubtaskCount}/{task.subtaskCount}
                </Badge>
              ) : undefined,
            content: <SubtaskChecklist task={task} />,
          } satisfies DetailSection,
        ]),
    {
      id: "photos",
      title: "Photos",
      icon: ImageIcon,
      placement: "supporting",
      content: (
        <EntityPhotosSection entity="task" id={task.id} images={task.images} />
      ),
    },
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
              <Row align="center" gap="tight">
                <EntityInlineLink
                  displayImage={undefined}
                  entity="task"
                  data={{
                    id: task.parentTaskId,
                    name: task.parentTaskName,
                  }}
                  truncate
                />
                <EntityFilterLink
                  to="/tasks"
                  search={{ view: "list", parentTask: task.parentTaskId }}
                  label={`Show all subtasks of ${task.parentTaskName}`}
                />
              </Row>
            ),
          } satisfies DetailHeroStat,
        ]
      : []),
    {
      label: "Trade",
      value: renderOptionCell(task.trade, tradeOptions),
    },
    {
      label: "Due",
      value: formatDateRange(task.dueDate, task.dueEndDate),
    },
    {
      label: "Project",
      value:
        task.projectId && task.projectName ? (
          <EntityInlineLink
            displayImage={undefined}
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
      heroImages={task.images}
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
      heroActions={{
        primary: (
          <Button variant="outline" onClick={() => setFollowUpOpen(true)}>
            <CalendarPlus />
            Schedule follow-up
          </Button>
        ),
      }}
    >
      <DetailSections
        sections={sections}
        rawData={task}
        heroImages={task.images}
      />
      <EntityEditDialog
        open={followUpOpen}
        onOpenChange={setFollowUpOpen}
        request={taskCaptureRequest({
          name: task.name,
          projectId: task.projectId,
          trade: task.trade,
          subjectProductId: task.subjectProductId,
        })}
      />
    </Page>
  );
};
