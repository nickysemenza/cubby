import { ingredientFiltersSchema } from "@cubby/schemas/ingredient";
import { getTableName, sql } from "drizzle-orm";

import { ingredient as table } from "~/server/db/schema";
import { ingredientScaffold } from "~/server/domains/ingredient/repo/search";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { entityProblemSources } from "~/server/generic/work-queue/repo/work-declarations";
import { type WorkSource } from "~/server/generic/work-queue/repo/work-source";

export const ingredientWorkSources = async (): Promise<WorkSource[]> => [
  ...entityProblemSources("ingredient", {
    table,
    columns: {
      name: await labelSql("ingredient", `"${getTableName(table)}"`),
      owners: sql`ARRAY[]::uuid[]`,
      shared: true,
    },
    scaffold: ingredientScaffold,
    parseFilters: ingredientFiltersSchema.parse,
  }),
];
