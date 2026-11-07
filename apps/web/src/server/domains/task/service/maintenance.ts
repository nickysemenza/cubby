import { maintenanceHistoryOut } from "@cubby/schemas/household-maintenance";
import { projectShortcode } from "@cubby/schemas/identifiers";
import { taskFiltersSchema } from "@cubby/schemas/project";
import { rawTaskListItemOut } from "@cubby/schemas/work-raw-read";
import { z } from "zod";

import type { Database } from "~/server/db";
import { projectScaffold } from "~/server/domains/project/repo/lookup";
import { taskScaffold } from "~/server/domains/task/repo/lookup";
import { maintenanceHistory } from "~/server/domains/task/repo/maintenance";
import { listAll } from "~/server/generic/list/repo/list-all";

export async function getMaintenanceHistory(
  db: Database,
  filters: z.infer<typeof taskFiltersSchema>,
): Promise<z.infer<typeof maintenanceHistoryOut>> {
  const projects = (
    await listAll((pagination) =>
      projectScaffold.read(db, {
        filters: { search: filters.maintenanceProjectSearch ?? "maintenance" },
        sorts: [{ orderBy: "name", direction: "asc" }],
        pagination,
      }),
    )
  ).data;
  const projectIds = projects
    .map((row) =>
      z.object({ id: projectShortcode, name: z.string() }).parse(row),
    )
    .filter((row) =>
      row.name
        .toLowerCase()
        .includes(
          (filters.maintenanceProjectSearch ?? "maintenance").toLowerCase(),
        ),
    )
    .map((row) => row.id);
  const tasks = (
    await listAll((pagination) =>
      taskScaffold.read(db, {
        filters: {
          ...filters,
          maintenanceProjectSearch:
            filters.maintenanceProjectSearch ?? "maintenance",
        },
        pagination,
        sorts: [{ orderBy: "name", direction: "asc" }],
      }),
    )
  ).data;
  return {
    groups: maintenanceHistory(
      tasks.map((row) => rawTaskListItemOut.parse(row)),
    ),
    projectIds,
  };
}
