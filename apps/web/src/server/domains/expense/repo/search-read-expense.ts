import { entitySchema } from "@cubby/schemas/entity";
import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, uuidArrayParam, notDeleted } from "~/server/db/helpers";
import { expense as searchTableexpense } from "~/server/db/schema";
import { expense, purchase, vendor } from "~/server/db/schema";
import { expenseDerivedReadSql } from "~/server/domains/expense/repo/expense-derived-read";
import { effectiveExpenseTradeSql } from "~/server/domains/expense/repo/expense-inheritance";
import { buildExpenseEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
import type {
  EmbeddingLoadOptions,
  SearchableEntityText,
  SearchReadPort,
} from "~/server/generic/search/repo/search-read-port";

async function loadEmbeddingText(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = unwrapDb(db)
    .select({
      id: expense.id,
      name: expense.name,
      lineKind: expense.lineKind,
      costType: expense.costType,
      trade: effectiveExpenseTradeSql(),
      notes: expense.notes,
      projectName: sql<string | null>`derived_names."projectNames"`,
      vendorName: vendor.name,
      orderId: purchase.orderId,
    })
    .from(expense)
    .leftJoin(
      sql`(${expenseDerivedReadSql("names", {
        expenseIds: options.ids?.map((id) => parseEntityId("expense", id)),
      })}) derived_names`,
      sql`derived_names."expenseId" = ${expense.id}`,
    )
    .leftJoin(
      purchase,
      and(eq(expense.purchaseId, purchase.id), notDeleted(purchase)),
    )
    .leftJoin(vendor, and(eq(purchase.vendorId, vendor.id), notDeleted(vendor)))
    .where(
      and(
        notDeleted(expense),
        options.ids?.length
          ? inArray(
              expense.id,
              options.ids.map((id) => parseEntityId("expense", id)),
            )
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);
  return rows.map((row) => ({
    entityKind: "expense",
    entityId: row.id,
    embeddingText: buildExpenseEmbeddingText(row),
  }));
}
export const expenseSearch = {
  document: ({ types, requested, bounded, entityIds, page }) => {
    const expenseNameIds = entityIds
      ? uuidArrayParam(entityIds)
      : page?.pageSize
        ? sql`ARRAY(SELECT name_source.id FROM "Expense" name_source WHERE ${notDeleted(alias(searchTableexpense, "name_source"))} AND ${bounded(sql`name_source."createdAt"`)} ${page.cursor ? sql`AND (${entitySchema.enum.expense}::text, name_source.id) > (${page.cursor.entityKind}, ${page.cursor.entityId}::uuid)` : sql``} ORDER BY name_source.id LIMIT ${page.pageSize})`
        : undefined;
    return sql`
      SELECT ${entitySchema.enum.expense}, e."id"::text, e."shortcode", e."name", names."projectNames", CASE WHEN e."lineKind" = ${expenseLineKindSchema.enum.principal} THEN e."costType" ELSE e."lineKind" END, ARRAY[]::text[], ARRAY[e."lineKind", ${effectiveExpenseTradeSql("e")}, e."costType", e."notes"]::text[]
      FROM "Expense" e
      LEFT JOIN (${expenseDerivedReadSql("names", { expenseIds: expenseNameIds })}) names ON names."expenseId" = e."id"
      WHERE ${notDeleted(alias(searchTableexpense, "e"))} AND ${entitySchema.enum.expense} IN (${types}) AND ${requested(sql`e."id"`)} AND ${bounded(sql`e."createdAt"`)}`;
  },
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
