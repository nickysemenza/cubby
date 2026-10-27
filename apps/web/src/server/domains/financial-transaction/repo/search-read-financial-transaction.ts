import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import {
  financialAccount as searchTablefinancialAccount,
  financialTransaction as searchTablefinancialTransaction,
} from "~/server/db/schema";
import {
  financialAccount,
  financialTransaction,
  purchase,
  vendor,
} from "~/server/db/schema";
import { solePurchaseForTransaction } from "~/server/domains/financial-transaction/repo/financial-transaction-allocations";
import { buildFinancialTransactionEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
import { settlementRefsFor } from "~/server/generic/entity-links/repo/entity-external-ids";
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
      id: financialTransaction.id,
      merchant: financialTransaction.merchant,
      rawDescription: financialTransaction.rawDescription,
      sourceCategory: financialTransaction.sourceCategory,
      notes: financialTransaction.notes,
      accountName: financialAccount.name,
      vendorName: vendor.name,
      orderId: purchase.orderId,
      kind: financialTransaction.kind,
      status: financialTransaction.status,
      transactionDate: financialTransaction.transactionDate,
      postedDate: financialTransaction.postedDate,
    })
    .from(financialTransaction)
    .innerJoin(
      financialAccount,
      and(
        eq(financialTransaction.accountId, financialAccount.id),
        notDeleted(financialAccount),
      ),
    )
    // Resolved through the allocation table, so a split transaction still gets a
    // vendor and order in its embedded text instead of the NULL its mirror now
    // holds. The correlated pick keeps exactly one row per transaction: a split
    // contributes its first purchase by id rather than all of them, which is a
    // deliberate narrowing — aggregating several vendors into one subtitle is
    // not worth it for the handful of rows that will ever be split.
    .leftJoin(
      purchase,
      and(eq(purchase.id, solePurchaseForTransaction), notDeleted(purchase)),
    )
    .leftJoin(vendor, and(eq(purchase.vendorId, vendor.id), notDeleted(vendor)))
    .where(
      and(
        notDeleted(financialTransaction),
        options.ids?.length
          ? inArray(
              financialTransaction.id,
              options.ids.map((id) =>
                parseEntityId("financialTransaction", id),
              ),
            )
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);
  const sourceRefs = await settlementRefsFor(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    entityKind: "financialTransaction",
    entityId: row.id,
    embeddingText: buildFinancialTransactionEmbeddingText({
      ...row,
      sourceRefTerms: (sourceRefs.get(row.id) ?? []).flatMap((ref) => [
        ref.source,
        ref.externalId,
      ]),
    }),
  }));
}
export const financialTransactionSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.financialTransaction}, ft."id"::text, ft."shortcode", COALESCE(NULLIF(ft."merchant", ''), NULLIF(ft."rawDescription", ''), ft."kind"), fa."name", ft."status", ARRAY[]::text[], ARRAY[ft."sourceCategory", ft."transactionDate"::text, ft."postedDate"::text]::text[]
      FROM "FinancialTransaction" ft JOIN "FinancialAccount" fa ON fa."id" = ft."accountId" AND ${notDeleted(alias(searchTablefinancialAccount, "fa"))}
      WHERE ${notDeleted(alias(searchTablefinancialTransaction, "ft"))} AND ${entitySchema.enum.financialTransaction} IN (${types}) AND ${requested(sql`ft."id"`)} AND ${bounded(sql`ft."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
