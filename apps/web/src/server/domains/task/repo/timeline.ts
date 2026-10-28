import type { TaskFilters } from "@cubby/schemas/project";
import {
  rawTaskOut,
  type RawTaskTimelineOut,
} from "@cubby/schemas/work-raw-read";
import { z } from "zod";

import type { Database } from "~/server/db";
import { listAll } from "~/server/generic/list/repo/list-all";

import { taskScaffold } from "./lookup";

/** Server-enforced dated-task renderer with an explicit omitted-row count. */
export async function getTaskTimeline(
  db: Database,
  filters: TaskFilters,
): Promise<RawTaskTimelineOut> {
  const explicitlyUndated = filters.duePresenceFilter === "none";
  const dateWindowActive = Boolean(filters.dueFrom || filters.dueTo);

  const datedPromise = explicitlyUndated
    ? Promise.resolve({ data: [], count: 0 })
    : listAll((pagination) =>
        taskScaffold.read(db, {
          filters: { ...filters, duePresenceFilter: "has" },
          sorts: [{ orderBy: "dueDate", direction: "asc" }],
          pagination,
        }),
      );
  const undatedPromise =
    filters.duePresenceFilter === "has" || dateWindowActive
      ? Promise.resolve({ data: [], count: 0 })
      : taskScaffold.read(db, {
          filters: { ...filters, duePresenceFilter: "none" },
          sorts: [],
          pagination: { pageIndex: 0, pageSize: 1 },
          readIntent: "count",
        });

  const [dated, undated] = await Promise.all([datedPromise, undatedPromise]);
  return {
    tasks: dated.data.map((row) => rawTaskOut.parse(row)),
    undatedCount: z.number().parse(undated.count),
  };
}
