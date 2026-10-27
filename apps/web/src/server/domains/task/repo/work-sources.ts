import { taskFiltersSchema } from "@cubby/schemas/project";
import { and, getTableName, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { task as table } from "~/server/db/schema";
import { taskScaffold } from "~/server/domains/task/repo/lookup";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import {
  entityProblemSources,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

export const taskWorkSources = (): WorkSource[] => [
  ...entityProblemSources("task", async (db, source, scope, assembly) => {
    const filters = compileProblemFilters("task", assembly);
    return {
      query: selectWorkCandidates(db, source, {
        entity: "task",
        id: sql`${table.shortcode}`,
        name: labelSql("task", `"${getTableName(table)}"`),
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        reason: source.reasons[0]!.label,
        reasonKeys: [source.id],
      })
        .from(table)
        .where(
          and(
            await taskScaffold.prepareWhere(
              db,
              taskFiltersSchema.parse(filters),
            ),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  }),
];
