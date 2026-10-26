import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { expense } from "~/server/db/schema";
import { expenseDerivedReadSql } from "~/server/domains/expense/repo/expense-derived-read";
import { expenseProductExpectedSql } from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
export const EXPENSE_QUALITY_RULES_VERSION = 2;

type ExpenseQualityRecord = Awaited<
  ReturnType<typeof loadExpenseQualityRecords>
>[number];
const observed = qualityCheck.observed<ExpenseQualityRecord>;
const when = qualityCheck.when<ExpenseQualityRecord>;

export const expenseChecks = defineStoredEntityChecks({
  entity: "expense",
  table: expense,
  rulesVersion: EXPENSE_QUALITY_RULES_VERSION,
  load: loadExpenseQualityRecords,
  checks: {
    expense_receipt_role: when(
      (r) => !r.future,
      observed((r) => r.lineKind !== "unclassified"),
    ),
    // Planned lines may be unpriced. Zero is a recorded cost.
    expense_cost: when(
      (r) => !r.future,
      observed((r) => r.cost !== null),
    ),
    expense_spending_category: when(
      (r) => !r.future,
      observed((r) => !r.categoryMissing),
    ),
    // Only merchandise expected by the domain policy feeds the unit ledger.
    expense_quantity: when(
      (r) => !r.future && r.productExpected,
      observed((r) => r.productQuantity !== null),
    ),
    expense_product_resolution: when(
      (r) => r.productExpected,
      observed((r) => r.productId !== null),
    ),
    expense_display_image: observed((r) => r.hasDisplayImage),
  },
});

async function loadExpenseQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  // Resolve allocations and inherited category policy for this page only. The
  // domain owners retain sibling weighting, rounding and ancestor precedence.
  const categories = sql`(SELECT "expenseId",
    bool_or("spendingCategoryId" IS NULL OR incomplete) AS missing
    FROM (${expenseDerivedReadSql("categories", {
      expenseIds: uuidArrayParam(ids),
    })}) category_share GROUP BY "expenseId") quality_category`;
  return unwrapDb(db)
    .select({
      id: expense.id,
      shortcode: expense.shortcode,
      future: expense.future,
      lineKind: expense.lineKind,
      cost: expense.cost,
      productQuantity: expense.productQuantity,
      productId: expense.productId,
      categoryMissing: sql<boolean>`coalesce(quality_category.missing, true)`,
      productExpected: sql<boolean>`${expenseProductExpectedSql("Expense")}`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("expense", sql`${expense.id}`)}`,
    })
    .from(expense)
    .leftJoin(categories, sql`quality_category."expenseId" = ${expense.id}`)
    .where(
      and(
        notDeleted(expense),
        sql`${expense.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
}
