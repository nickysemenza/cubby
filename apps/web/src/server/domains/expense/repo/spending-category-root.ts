import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import type { ExpenseAnalyzeBucket } from "@cubby/schemas/project";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers";
import { spendingCategory } from "~/server/db/schema";
import { hierarchyAncestorSql } from "~/server/generic/list/repo/hierarchy";

/**
 * Root Spending Category buckets over `allocation` share rows. Every share
 * lands in exactly one bucket, so a root breakdown reconciles to the filtered
 * net: an unresolved receipt role is Unclassified (its share never inherits a
 * category), any other share with no live category is Uncategorized.
 */
export const UNCATEGORIZED_BUCKET = "uncategorized";
export const UNCLASSIFIED_BUCKET = "unclassified";

const rootSpendingCategory = alias(spendingCategory, "rootSpendingCategory");

/** Each live category's live root, walked once per category, not per share. */
const categoryRootsSql = sql`(SELECT c."id", ${hierarchyAncestorSql(
  "spendingCategory",
  sql`c."id"`,
  1,
)} AS "rootId" FROM ${spendingCategory} c WHERE c."deletedAt" IS NULL) category_root`;

/** Joins for `rootSpendingCategory` beside an `allocation` share relation. */
export const rootSpendingCategoryJoins = {
  roots: {
    table: categoryRootsSql,
    on: sql`category_root."id" = allocation."spendingCategoryId"`,
  },
  root: {
    table: rootSpendingCategory,
    on: and(
      eq(rootSpendingCategory.id, sql`category_root."rootId"`),
      notDeleted(rootSpendingCategory),
    ),
  },
} as const;

// Literals, not bind parameters: the same expression is selected and grouped,
// and PostgreSQL only matches GROUP BY expressions with identical constants.
const literal = (value: string) => sql.raw(`'${value}'::text`);
const unclassifiedShare = sql`allocation.basis = ${literal(expenseLineKindSchema.enum.unclassified)}`;

export const rootSpendingCategoryKeySql = sql<string>`CASE
  WHEN ${unclassifiedShare} THEN ${literal(UNCLASSIFIED_BUCKET)}
  WHEN ${rootSpendingCategory.shortcode} IS NULL THEN ${literal(UNCATEGORIZED_BUCKET)}
  ELSE ${rootSpendingCategory.shortcode} END`;

export const rootSpendingCategoryLabelSql = sql<string>`CASE
  WHEN ${unclassifiedShare} THEN ${literal("Unclassified")}
  WHEN ${rootSpendingCategory.shortcode} IS NULL THEN ${literal("Uncategorized")}
  ELSE ${rootSpendingCategory.name} END`;

const classifiedLineKinds = expenseLineKindSchema.options
  .filter((kind) => kind !== expenseLineKindSchema.enum.unclassified)
  .join(",");

/**
 * Ledger URL search params selecting a root bucket's rows: the root with its
 * subcategories, the no-category rows apart from unresolved receipt roles, or
 * the unresolved receipt roles.
 */
export const rootSpendingCategoryBucketFilter = (
  key: string,
): ExpenseAnalyzeBucket["filter"] => {
  if (key === UNCLASSIFIED_BUCKET)
    return { lineKind: expenseLineKindSchema.enum.unclassified };
  if (key === UNCATEGORIZED_BUCKET)
    return { spendingCategory: FILTER_NONE, lineKind: classifiedLineKinds };
  return { spendingCategory: key, includeSubSpendingCategories: "true" };
};
