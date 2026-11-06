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
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

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
    const candidates = (missingInputs: boolean) =>
      selectWorkCandidates(db, gaps, {
        entity: "product",
        id: sql`${table.shortcode}`,
        name: sql`"Product".name`,
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        ...readGap.columns,
        ...(missingInputs ? readGap.missingColumns : {}),
      })
        .from(table)
        .leftJoin(readGap.publication, readGap.match)
        .where(
          and(
            where,
            missingInputs ? readGap.missingInputs : readGap.admission,
            recordScope(scope, sql`${table.shortcode}`),
          ),
        );
    return {
      query: candidates(false),
      missingInputs: candidates(true),
    };
  },
};
export const productWorkSources = (): WorkSource[] => [
  gapSource,
  ...entityProblemSources("product", {
    table,
    columns: {
      name: labelSql("product", `"${getTableName(table)}"`),
      owners: sql`ARRAY[]::uuid[]`,
      shared: true,
    },
    scaffold: productScaffold,
    parseFilters: productFiltersSchema.parse,
  }),
];
