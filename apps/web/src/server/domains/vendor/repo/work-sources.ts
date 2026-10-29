import { vendorFiltersSchema } from "@cubby/schemas/vendor";
import { and, getTableName, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { vendor as table } from "~/server/db/schema";
import { vendorScaffold } from "~/server/domains/vendor/repo/vendor";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import {
  entityProblemSources,
  gapDeclaration,
  gapPublicationRead,
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
    const readGap = gapPublicationRead({ scope, entity: "vendor" });
    if (!readGap) return null;
    return {
      query: selectWorkCandidates(db, gaps, {
        entity: "vendor",
        id: sql`${table.shortcode}`,
        name: sql`"Vendor".name`,
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        ...readGap.columns,
      })
        .from(table)
        .leftJoin(readGap.publication, readGap.match)
        .where(
          and(
            await vendorScaffold.prepareWhere(
              db,
              vendorFiltersSchema.parse(readGap.filters),
            ),
            readGap.admission,
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
            await vendorScaffold.prepareWhere(
              db,
              vendorFiltersSchema.parse(filters),
            ),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  }),
];
