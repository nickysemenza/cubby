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
  gapFilters,
  gapColumns,
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
    const filters = gapFilters(scope, "product");
    if (!filters) return null;
    const read = productWorkReadContext(scope);
    return {
      query: selectWorkCandidates(db, gaps, {
        entity: "product",
        id: sql`${table.shortcode}`,
        name: sql`"Product".name`,
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        ...gapColumns(scope, "product"),
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
