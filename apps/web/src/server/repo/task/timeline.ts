import type { ActorContext } from "@cubby/schemas/context";
import type { TaskFilters, TaskTimelineOut } from "@cubby/schemas/project";

import type { Database } from "~/server/db";
import { listAll } from "~/server/repo/list-all";

import { taskList } from "./lookup";

/** Server-enforced dated-task renderer with an explicit omitted-row count. */
export async function getTaskTimeline(
  db: Database,
  filters: TaskFilters,
  actor?: ActorContext,
): Promise<TaskTimelineOut> {
  const explicitlyUndated = filters.duePresenceFilter === "none";
  const dateWindowActive = Boolean(filters.dueFrom || filters.dueTo);

  const datedPromise = explicitlyUndated
    ? Promise.resolve({ data: [], count: 0 })
    : listAll((pagination) =>
        taskList(
          db,
          { ...filters, duePresenceFilter: "has" },
          [{ orderBy: "dueDate", direction: "asc" }],
          pagination,
          "page",
          actor,
        ),
      );
  const undatedPromise =
    filters.duePresenceFilter === "has" || dateWindowActive
      ? Promise.resolve({ data: [], count: 0 })
      : taskList(
          db,
          { ...filters, duePresenceFilter: "none" },
          [],
          {
            pageIndex: 0,
            pageSize: 1,
          },
          "page",
          actor,
        );

  const [dated, undated] = await Promise.all([datedPromise, undatedPromise]);
  return { tasks: dated.data, undatedCount: undated.count };
}
