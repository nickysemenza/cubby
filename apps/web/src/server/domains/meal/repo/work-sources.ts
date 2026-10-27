import { mealFiltersSchema } from "@cubby/schemas/meal";
import { and, getTableName, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { meal as table } from "~/server/db/schema";
import { mealScaffold } from "~/server/domains/meal/repo/crud";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import {
  entityProblemSources,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

export const mealWorkSources = (): WorkSource[] => [
  ...entityProblemSources("meal", async (db, source, scope, assembly) => {
    const filters = compileProblemFilters("meal", assembly);
    return {
      query: selectWorkCandidates(db, source, {
        entity: "meal",
        id: sql`${table.shortcode}`,
        name: labelSql("meal", `"${getTableName(table)}"`),
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        reason: source.reasons[0]!.label,
        reasonKeys: [source.id],
      })
        .from(table)
        .where(
          and(
            await mealScaffold.prepareWhere(
              db,
              mealFiltersSchema.parse(filters),
            ),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  }),
];
