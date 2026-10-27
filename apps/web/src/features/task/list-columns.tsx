import type { TaskFilters } from "@cubby/schemas/project";
import type { ReactNode } from "react";
import { useMemo } from "react";

import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { Badge } from "~/ui/primitives/badge";

import { defineListOverride } from "../../entity/list-columns/types";

/** `N/M` checklist chip after a parent task's name. */
const subtaskCountSuffix = (row: TaskOut): ReactNode =>
  row.subtaskCount > 0 ? (
    <Badge variant="outline">
      {row.doneSubtaskCount}/{row.subtaskCount}
    </Badge>
  ) : undefined;

export const taskListOverride = defineListOverride<TaskOut, TaskFilters>({
  use() {
    const list = useMemo(
      () => ({
        deletable: true as const,
        nameSuffix: subtaskCountSuffix,
      }),
      [],
    );
    return { list };
  },
});

type TaskOut = DetailRecordOf<"task">;
