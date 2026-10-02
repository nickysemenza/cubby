import type { TaskFilters, TaskOut } from "@cubby/schemas/project";
import type { ReactNode } from "react";
import { useMemo } from "react";

import { useDeferredFilterOptions } from "~/ui/hooks/useDeferredFilterOptions";
import { useFilterOptions } from "~/ui/hooks/useFilterOptions";
import { Badge } from "~/ui/primitives/badge";

import { defineListOverride } from "./types";

/** `N/M` checklist chip after a parent task's name. */
const subtaskCountSuffix = (row: TaskOut): ReactNode =>
  row.subtaskCount > 0 ? (
    <Badge variant="outline">
      {row.doneSubtaskCount}/{row.subtaskCount}
    </Badge>
  ) : undefined;

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
    const list = useMemo(
      () => ({
        deletable: true as const,
        filterOptions,
        nameSuffix: subtaskCountSuffix,
        additionalReadFields: ["subtaskCount", "doneSubtaskCount"],
      }),
      [filterOptions],
    );
    return { list };
  },
});
