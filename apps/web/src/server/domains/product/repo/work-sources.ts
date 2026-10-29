import { productFiltersSchema } from "@cubby/schemas/product";
import { and, getTableName, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { product as table } from "~/server/db/schema";
import { productScaffold } from "~/server/domains/product/repo/crud";
import { productWorkReadContext } from "~/server/domains/product/repo/work-read-context";
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
    const read = productWorkReadContext(scope);
    return {
      query: selectWorkCandidates(db, gaps, {
        entity: "product",
        id: sql`${table.shortcode}`,
        name: sql`"Product".name`,
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        ...readGap.columns,
      })
        .from(table)
        .leftJoin(readGap.publication, readGap.match)
        .where(
          and(
            await productScaffold.prepareWhere(
              db,
              productFiltersSchema.parse(readGap.filters),
              [],
              read.context,
            ),
            readGap.admission,
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
      ctes: read.ctes,
    };
  },
};
export const productWorkSources = (): WorkSource[] => [
  gapSource,
  ...entityProblemSources("product", async (db, source, scope, assembly) => {
    const filters = compileProblemFilters("product", assembly);
    const read = productWorkReadContext(scope);
    return {
      query: selectWorkCandidates(db, source, {
        entity: "product",
        id: sql`${table.shortcode}`,
        name: labelSql("product", `"${getTableName(table)}"`),
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        reason: source.reasons[0]!.label,
        reasonKeys: [source.id],
      })
        .from(table)
        .where(
          and(
            await productScaffold.prepareWhere(
              db,
              productFiltersSchema.parse(filters),
              [],
              read.context,
            ),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
      ctes: read.ctes,
    };
  }),
];
