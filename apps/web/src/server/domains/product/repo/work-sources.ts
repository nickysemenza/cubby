import { dataCheck, type DataCheck } from "@cubby/schemas/data-quality";
import { entityQualityCheckState } from "@cubby/schemas/data-quality-shape";
import { oneOrManyValues } from "@cubby/schemas/pagination";
import { productFiltersSchema } from "@cubby/schemas/product";
import { and, getTableName, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { derivedValue } from "~/server/db/retained-tables";
import { product as table } from "~/server/db/schema";
import { productScaffold } from "~/server/domains/product/repo/crud";
import { productWorkReadContext } from "~/server/domains/product/repo/work-read-context";
import { storedPublicationMatch } from "~/server/generic/derived/repo/read";
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
const quality = alias(derivedValue, "work_product_quality");
const publishedGap = (check: DataCheck) =>
  sql`coalesce(${quality.value}->'checks'->>${check} = ${entityQualityCheckState.enum.gap}, false)`;
const gapSource: WorkSource = {
  ...gaps,
  candidates: async (db, scope) => {
    const filters = gapFilters(scope, "product");
    if (!filters) return null;
    const { dataGap, ...otherFilters } = filters;
    const admittedChecks = (oneOrManyValues(dataGap) ?? []).map((check) =>
      dataCheck.parse(check),
    );
    const read = productWorkReadContext(scope);
    return {
      query: selectWorkCandidates(db, gaps, {
        entity: "product",
        id: sql`${table.shortcode}`,
        name: sql`"Product".name`,
        owners: sql`ARRAY[]::uuid[]`,
        shared: true,
        ...gapColumns(scope, "product", publishedGap),
      })
        .from(table)
        .leftJoin(
          quality,
          storedPublicationMatch(quality, {
            entity: gaps.entity,
            id: table.id,
            key: "dataQuality",
          }),
        )
        .where(
          and(
            await productScaffold.prepareWhere(
              db,
              productFiltersSchema.parse(otherFilters),
              [],
              read.context,
            ),
            admittedChecks.length
              ? or(...admittedChecks.map(publishedGap))
              : undefined,
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
