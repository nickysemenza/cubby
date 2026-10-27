import { locationFiltersSchema } from "@cubby/schemas/location";
import { and, getTableName, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { location as table } from "~/server/db/schema";
import { buildLocationWhere } from "~/server/domains/location/repo/crud";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import {
  entityProblemSources,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

export const locationWorkSources = (): WorkSource[] => [
  ...entityProblemSources("location", async (db, source, scope, assembly) => {
    const filters = compileProblemFilters("location", assembly);
    return {
      query: selectWorkCandidates(db, source, {
        entity: "location",
        id: sql`${table.shortcode}`,
        name: labelSql("location", `"${getTableName(table)}"`),
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        reason: source.reasons[0]!.label,
        reasonKeys: [source.id],
      })
        .from(table)
        .where(
          and(
            await buildLocationWhere(db, locationFiltersSchema.parse(filters)),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  }),
];
