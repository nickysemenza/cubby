import type { TaskFilters, TaskTimelineOut } from "@cubby/schemas/project";
import type { Database } from "~/server/db";
import { taskList } from "./lookup";

const ALL_ROWS = { pageIndex: 0, pageSize: 100_000 } as const;

/** Server-enforced dated-task renderer with an explicit omitted-row count. */
export async function getTaskTimeline(
  db: Database,
  filters: TaskFilters,
): Promise<TaskTimelineOut> {
  const explicitlyUndated = filters.duePresenceFilter === "none";
  const dateWindowActive = Boolean(filters.dueFrom || filters.dueTo);

  const datedPromise = explicitlyUndated
    ? Promise.resolve({ data: [], count: 0 })
    : taskList(
        db,
        { ...filters, duePresenceFilter: "has" },
        [{ orderBy: "dueDate", direction: "asc" }],
        ALL_ROWS,
      );
  const undatedPromise =
    filters.duePresenceFilter === "has" || dateWindowActive
      ? Promise.resolve({ data: [], count: 0 })
      : taskList(db, { ...filters, duePresenceFilter: "none" }, [], {
          pageIndex: 0,
          pageSize: 1,
        });

  const [dated, undated] = await Promise.all([datedPromise, undatedPromise]);
  return { tasks: dated.data, undatedCount: undated.count };
}
