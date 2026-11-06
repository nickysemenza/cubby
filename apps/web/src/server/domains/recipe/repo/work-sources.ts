import { recipeFiltersSchema } from "@cubby/schemas/recipe";
import { getTableName, sql } from "drizzle-orm";

import { recipe as table } from "~/server/db/schema";
import { recipeScaffold } from "~/server/domains/recipe/repo/crud";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { entityProblemSources } from "~/server/generic/work-queue/repo/work-declarations";
import { type WorkSource } from "~/server/generic/work-queue/repo/work-source";

export const recipeWorkSources = async (): Promise<WorkSource[]> => [
  ...entityProblemSources("recipe", {
    table,
    columns: {
      name: await labelSql("recipe", `"${getTableName(table)}"`),
      owners: sql`ARRAY[]::uuid[]`,
      shared: true,
    },
    scaffold: recipeScaffold,
    parseFilters: recipeFiltersSchema.parse,
  }),
];
