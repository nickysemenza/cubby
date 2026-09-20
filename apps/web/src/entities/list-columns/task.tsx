import type { TaskFilters, TaskOut } from "@cubby/schemas/project";
import type { ReactNode } from "react";
import { useMemo } from "react";

import {
  createParentLinkColumn,
  createProjectLinkColumn,
  createSubjectProductLinkColumn,
} from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { useDeferredFilterOptions } from "~/app/_components/hooks/useDeferredFilterOptions";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import {
  taskDueColumn,
  taskStatusColumn,
  taskTradeColumn,
} from "~/app/projects/shared";
import { Badge } from "~/components/ui/badge";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListHiddenColumns } from "~/entities/entity-display";
import { manifestFilterConfig } from "~/entities/filter-manifest";

import { defineListOverride } from "./types";

const columnHelper = createCubbyColumnHelper<TaskOut>();
const TASK_INITIAL_COLUMN_VISIBILITY = entityListHiddenColumns("task");

/** `N/M` checklist chip after a parent task's name. */
const subtaskCountSuffix = (row: TaskOut): ReactNode =>
  row.subtaskCount > 0 ? (
    <Badge variant="outline">
      {row.doneSubtaskCount}/{row.subtaskCount}
    </Badge>
  ) : undefined;

/**
 * The status / due / trade columns come from the shared factories also used
 * by the embedded task table on the project detail page, so the two can't
 * drift. `project` / `subjectProduct` / `parentTask` keep those column ids
 * via `display.columnId`.
 */
export const taskListOverride = defineListOverride<TaskOut, TaskFilters>({
  use() {
    const projectOptions = useDeferredFilterOptions("project");
    const productOptions = useDeferredFilterOptions("product");
    const parentOptions = useDeferredFilterOptions("task");
    const filterOptions = useFilterOptions({
      project: projectOptions,
      taskProducts: productOptions,
      parentTask: parentOptions,
    });
    const updateTaskMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("task", "update"),
      entity: "task",
    });
    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<TaskOut>((add) => {
          add(
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
          );
          add(
            createProjectLinkColumn(columnHelper, {
              className: "w-40",
              mobile: { slot: "meta", priority: 30, interactive: true },
              editable: {
                onSave: async (newProjectId, task) => {
                  await updateTaskMutation.mutateAsync({
                    id: task.id,
                    data: { projectId: newProjectId },
                  });
                },
                suggest: { entity: "task", field: "projectId" },
              },
            }),
          );
          add(
            createSubjectProductLinkColumn(columnHelper, {
              className: "w-40",
              mobile: { slot: "meta", priority: 35, interactive: true },
              editable: {
                onSave: async (subjectProductId, task) => {
                  await updateTaskMutation.mutateAsync({
                    id: task.id,
                    data: { subjectProductId },
                  });
                },
              },
            }),
          );
          add(
            createParentLinkColumn(
              columnHelper,
              "task",
              "parentTaskId",
              "parentTaskName",
              {
                filterConfig: manifestFilterConfig("task", "parentTask", {
                  parentTask: parentOptions,
                }),
              },
            ),
          );
          add(
            taskDueColumn(
              columnHelper,
              async (dueDate, task) => {
                await updateTaskMutation.mutateAsync({
                  id: task.id,
                  data: { dueDate },
                });
              },
              { mobile: { slot: "meta", priority: 40, interactive: true } },
            ),
          );
          add(
            taskTradeColumn(
              columnHelper,
              async (trade, task) => {
                await updateTaskMutation.mutateAsync({
                  id: task.id,
                  data: { trade },
                });
              },
              { mobile: { slot: "meta", priority: 50 } },
            ),
          );
        }),
      // oxlint-disable-next-line react/exhaustive-deps -- The mutation wrapper changes identity while its operation contract remains stable.
      [parentOptions],
    );

    const list = useMemo(
      () => ({
        deletable: true as const,
        filterOptions,
        nameSuffix: subtaskCountSuffix,
        initialColumnVisibility: TASK_INITIAL_COLUMN_VISIBILITY,
      }),
      [filterOptions],
    );
    return { overrides, list };
  },
});
