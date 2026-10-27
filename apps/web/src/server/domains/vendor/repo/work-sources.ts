import { vendorFiltersSchema } from "@cubby/schemas/vendor";
import { and, getTableName, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { vendor as table } from "~/server/db/schema";
import { buildVendorWhereClause } from "~/server/domains/vendor/repo/vendor";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import {
  entityProblemSources,
  gapDeclaration,
  gapFilters,
  gapColumns,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

const gaps = gapDeclaration("vendor");
const gapSource: WorkSource = {
  ...gaps,
  candidates: async (db, scope) => {
    const filters = gapFilters(scope, "vendor");
    if (!filters) return null;
    return {
      query: selectWorkCandidates(db, gaps, {
        entity: "vendor",
        id: sql`${table.shortcode}`,
        name: sql`"Vendor".name`,
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        ...gapColumns(scope, "vendor"),
      })
        .from(table)
        .where(
          and(
            buildVendorWhereClause(vendorFiltersSchema.parse(filters)),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  },
};
export const vendorWorkSources = (): WorkSource[] => [
  gapSource,
  ...entityProblemSources("vendor", async (db, source, scope, assembly) => {
    const filters = compileProblemFilters("vendor", assembly);
    return {
      query: selectWorkCandidates(db, source, {
        entity: "vendor",
        id: sql`${table.shortcode}`,
        name: labelSql("vendor", `"${getTableName(table)}"`),
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        reason: source.reasons[0]!.label,
        reasonKeys: [source.id],
      })
        .from(table)
        .where(
          and(
            buildVendorWhereClause(vendorFiltersSchema.parse(filters)),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  }),
];
