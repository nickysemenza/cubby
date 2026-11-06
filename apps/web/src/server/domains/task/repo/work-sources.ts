import { taskFiltersSchema } from "@cubby/schemas/project";
import { getTableName, sql } from "drizzle-orm";

import { task as table } from "~/server/db/schema";
import { taskScaffold } from "~/server/domains/task/repo/lookup";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { entityProblemSources } from "~/server/generic/work-queue/repo/work-declarations";
import { type WorkSource } from "~/server/generic/work-queue/repo/work-source";

export const taskWorkSources = async (): Promise<WorkSource[]> => [
  ...entityProblemSources("task", {
    table,
    columns: {
      name: await labelSql("task", `"${getTableName(table)}"`),
      owners: sql`ARRAY[]::uuid[]`,
      shared: true,
    },
    scaffold: taskScaffold,
    parseFilters: taskFiltersSchema.parse,
  }),
];
