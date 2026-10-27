import { ingredientFiltersSchema } from "@cubby/schemas/ingredient";
import { and, getTableName, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { ingredient as table } from "~/server/db/schema";
import { buildIngredientListWhere } from "~/server/domains/ingredient/repo/search";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import {
  entityProblemSources,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

export const ingredientWorkSources = (): WorkSource[] => [
  ...entityProblemSources("ingredient", async (db, source, scope, assembly) => {
    const filters = compileProblemFilters("ingredient", assembly);
    return {
      query: selectWorkCandidates(db, source, {
        entity: "ingredient",
        id: sql`${table.shortcode}`,
        name: labelSql("ingredient", `"${getTableName(table)}"`),
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        reason: source.reasons[0]!.label,
        reasonKeys: [source.id],
      })
        .from(table)
        .where(
          and(
            buildIngredientListWhere(ingredientFiltersSchema.parse(filters)),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  }),
];
