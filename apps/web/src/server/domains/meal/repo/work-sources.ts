import { mealFiltersSchema } from "@cubby/schemas/meal";
import { getTableName, sql } from "drizzle-orm";

import { meal as table } from "~/server/db/schema";
import { mealScaffold } from "~/server/domains/meal/repo/crud";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { entityProblemSources } from "~/server/generic/work-queue/repo/work-declarations";
import { type WorkSource } from "~/server/generic/work-queue/repo/work-source";

export const mealWorkSources = (): WorkSource[] => [
  ...entityProblemSources("meal", {
    table,
    columns: {
      name: labelSql("meal", `"${getTableName(table)}"`),
      owners: sql`ARRAY[]::uuid[]`,
      shared: true,
    },
    scaffold: mealScaffold,
    parseFilters: mealFiltersSchema.parse,
  }),
];
