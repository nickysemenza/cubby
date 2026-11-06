import { vendorFiltersSchema } from "@cubby/schemas/vendor";
import { and, getTableName, sql } from "drizzle-orm";

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
    const baseWhere = await vendorScaffold.prepareWhere(
      db,
      vendorFiltersSchema.parse(readGap.filters),
    );
    const candidates = (missingInputs: boolean) =>
      selectWorkCandidates(db, gaps, {
        entity: "vendor",
        id: sql`${table.shortcode}`,
        name: sql`"Vendor".name`,
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        ...readGap.columns,
        ...(missingInputs ? readGap.missingColumns : {}),
      })
        .from(table)
        .leftJoin(readGap.publication, readGap.match)
        .where(
          and(
            baseWhere,
            missingInputs ? readGap.missingInputs : readGap.admission,
            recordScope(scope, sql`${table.shortcode}`),
          ),
        );
    return { query: candidates(false), missingInputs: candidates(true) };
  },
};
export const vendorWorkSources = async (): Promise<WorkSource[]> => [
  gapSource,
  ...entityProblemSources("vendor", {
    table,
    columns: {
      name: await labelSql("vendor", `"${getTableName(table)}"`),
      owners: sql`ARRAY[]::uuid[]`,
      shared: true,
    },
    scaffold: vendorScaffold,
    parseFilters: vendorFiltersSchema.parse,
  }),
];
