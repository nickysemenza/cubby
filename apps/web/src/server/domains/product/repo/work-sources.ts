import { productFiltersSchema } from "@cubby/schemas/product";
import { and, getTableName, sql } from "drizzle-orm";

import { product as table } from "~/server/db/schema";
import { productScaffold } from "~/server/domains/product/repo/crud";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import {
  entityProblemSources,
  gapDeclaration,
  gapPublicationRead,
  recordScope,
  selectWorkGapCandidates,
} from "~/server/generic/work-queue/repo/work-declarations";
import type { WorkSource } from "~/server/generic/work-queue/repo/work-source";

const gaps = gapDeclaration("product");
const gapSource: WorkSource = {
  ...gaps,
  candidates: async (db, scope) => {
    const readGap = gapPublicationRead({ scope, entity: "product" });
    if (!readGap) return null;
    const where = await productScaffold.prepareWhere(
      db,
      productFiltersSchema.parse(readGap.filters),
      [],
    );
    return selectWorkGapCandidates(db, gaps, {
      table,
      readGap,
      where: and(where, recordScope(scope, sql`${table.shortcode}`)),
      columns: {
        entity: "product",
        id: sql`${table.shortcode}`,
        name: sql`"Product".name`,
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
      },
    });
  },
};
export const productWorkSources = async (): Promise<WorkSource[]> => [
  gapSource,
  ...entityProblemSources("product", {
    table,
    columns: {
      name: await labelSql("product", `"${getTableName(table)}"`),
      owners: sql`ARRAY[]::uuid[]`,
      shared: true,
    },
    scaffold: productScaffold,
    parseFilters: productFiltersSchema.parse,
  }),
];
