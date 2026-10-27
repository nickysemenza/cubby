import { recipeFiltersSchema } from "@cubby/schemas/recipe";
import { and, getTableName, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { recipe as table } from "~/server/db/schema";
import { buildRecipeWhere } from "~/server/domains/recipe/repo/crud";
import { labelSql } from "~/server/generic/entity-graph/repo/entity-graph";
import {
  entityProblemSources,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

export const recipeWorkSources = (): WorkSource[] => [
  ...entityProblemSources("recipe", async (db, source, scope, assembly) => {
    const filters = compileProblemFilters("recipe", assembly);
    return {
      query: selectWorkCandidates(db, source, {
        entity: "recipe",
        id: sql`${table.shortcode}`,
        name: labelSql("recipe", `"${getTableName(table)}"`),
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        reason: source.reasons[0]!.label,
        reasonKeys: [source.id],
      })
        .from(table)
        .where(
          and(
            buildRecipeWhere(recipeFiltersSchema.parse(filters)),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  }),
];
