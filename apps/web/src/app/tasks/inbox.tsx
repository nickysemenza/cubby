import type { TaskShortcode } from "@cubby/schemas/identifiers";
import type { TaskOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  taskDueColumn,
  taskStatusColumn,
  taskTradeColumn,
} from "~/app/projects/shared";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Badge } from "~/components/ui/badge";
import { useTRPC } from "~/integrations/trpc/react";
import { taskMutationInvalidateKeys } from "~/lib/query-keys";
import RTable from "../_components/data-table/Table";
import { useClientEntityList } from "../_components/hooks/useClientEntityList";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import {
  TaskBulkActionDialogs,
  useTaskBulkActions,
} from "../_components/tracker/task-bulk-actions";
import { CreateProjectFromTasksDialog } from "./create-project-from-tasks-dialog";

/** Stable empty default — never a fresh `[]` per render (would churn memos). */
const NO_TASKS: TaskOut[] = [];

/**
 * `N/M` checklist chip after a parent task's name — mirrors tasklist.tsx's
 * `subtaskCountSuffix`. Module-level: a stable reference for the columns memo.
 */
const subtaskCountSuffix = (row: TaskOut): ReactNode =>
  row.subtaskCount > 0 ? (
    <Badge variant="outline">
      {row.doneSubtaskCount}/{row.subtaskCount}
    </Badge>
  ) : undefined;

/** Inbox is a triage queue, never large at single-user scale — one bounded page. */
const INBOX_PAGE_SIZE = 500;

/**
 * The `/tasks?view=inbox` surface: top-level, open tasks with no project — the
 * triage queue. Scoped server-side via `task.list`'s
 * `projectPresenceFilter: "none"` predicate (`projectId IS NULL`) — NOT
 * `task.chartData`'s fetch-all — so this view never pulls every open task in
 * the household, only the inbox's own (small) row set. Rendered through
 * `useClientEntityList` (client-data table — no UI pagination needed at inbox
 * scale, but the fetch itself is bounded).
 */
export function TaskInbox() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<TaskOut>(), []);
  const [createProjectTaskIds, setCreateProjectTaskIds] = useState<
    TaskShortcode[] | null
  >(null);
  const taskBulkActions = useTaskBulkActions({
    includeDueDate: true,
    onCreateProject: setCreateProjectTaskIds,
  });

  // `completion: "open"` matches `task.summary`'s `inbox` count exactly
  // (topLevelOpen + projectId IS NULL) — the stat tile and this view agree.
  const { data, isLoading } = useQuery(
    api.task.list.queryOptions({
      filters: {
        topLevelOnly: true,
        completion: "open",
        projectPresenceFilter: "none",
      },
      pagination: { pageIndex: 0, pageSize: INBOX_PAGE_SIZE },
    }),
  );
  const inboxTasks = data?.items ?? NO_TASKS;

  const updateTaskMutation = useUpdateMutation({
    mutationFn: api.task.update.mutationOptions,
    entity: "task",
    invalidateKeys: taskMutationInvalidateKeys,
  });

  const nameEditable = useNameEditable<TaskOut>(updateTaskMutation.mutateAsync);

  const deletableConfig = useDeletableConfig({
    mutationFn: api.task.delete.mutationOptions,
    entityLabel: "Task",
    invalidateKeys: taskMutationInvalidateKeys,
    entity: "task",
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateTaskMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      taskStatusColumn(
        columnHelper,
        async (status, task) => {
          await updateTaskMutation.mutateAsync({
            id: task.id,
            data: { status },
          });
        },
        { mobile: { slot: "subtitle", priority: 10 } },
      ),
      taskDueColumn(
        columnHelper,
        async (dueDate, task) => {
          await updateTaskMutation.mutateAsync({
            id: task.id,
            data: { dueDate },
          });
        },
        { mobile: { slot: "meta", priority: 30, interactive: true } },
      ),
      taskTradeColumn(
        columnHelper,
        async (trade, task) => {
          await updateTaskMutation.mutateAsync({
            id: task.id,
            data: { trade },
          });
        },
        { mobile: { slot: "meta", priority: 40 } },
      ),
    ],
    [columnHelper],
  );

  // Only the name box is a real `useStandardColumns` filter def (it feeds
  // the "name" column's search input) — status/trade already carry their own
  // working header filter via `createFilterableSelectColumn` inside
  // `taskStatusColumn`/`taskTradeColumn` above, independent of this list.
  const filters = useMemo(
    () => [{ id: "name", placeholder: "Search tasks..." }],
    [],
  );

  const { table, bulkActionBar, deleteDialog } = useClientEntityList({
    entity: "task",
    data: inboxTasks,
    columns,
    filters,
    deletable: deletableConfig,
    nameEditable,
    nameSuffix: subtaskCountSuffix,
    bulkActions: taskBulkActions.config,
  });

  if (isLoading) {
    return <SimpleLoading text="Loading inbox..." />;
  }

  return (
    <div>
      <RTable
        table={table}
        ariaLabel="Inbox Tasks Table"
        entity="task"
        bulkActionBar={bulkActionBar}
      />
      {deleteDialog}
      <TaskBulkActionDialogs
        controller={taskBulkActions}
        onComplete={() => table.resetRowSelection()}
      />
      {createProjectTaskIds && (
        <CreateProjectFromTasksDialog
          open={createProjectTaskIds !== null}
          onOpenChange={(open) => {
            if (!open) setCreateProjectTaskIds(null);
          }}
          taskIds={createProjectTaskIds}
        />
      )}
    </div>
  );
}
