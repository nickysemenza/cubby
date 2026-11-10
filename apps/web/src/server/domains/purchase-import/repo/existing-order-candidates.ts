import { expenseEconomicRoleSchema } from "@cubby/schemas/expense-fields";
import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import {
  parseShortcodeFor,
  type LedgerPartyId,
  type ShortcodeFor,
  type VendorId,
} from "@cubby/schemas/identifiers";
import { minorToMoney } from "@cubby/shared";
import {
  and,
  between,
  count,
  eq,
  exists,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { householdLocalDate, shiftPlainDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  email as emailTable,
  expense,
  financialTransactionAllocation,
  importSourceOrder,
  purchase,
  vendorAccount,
} from "~/server/db/schema";
import { emailPurchaseAssociationsSql } from "~/server/domains/email/repo/email-sql";

/** Most existing-order candidates a claim shows of each kind. */
export const EXISTING_ORDER_CANDIDATES_MAX = 5;
/** Days before and after an Email that a statement booking may sit. */
const LUMP_DAYS_BEFORE = 10;
const LUMP_DAYS_AFTER = 3;

/**
 * A live Purchase that may be the order this Email describes, shown to the
 * coordinator so it targets the Purchase instead of creating a second one.
 * Candidacy proves nothing: `thread` means another Email in the same mailbox
 * thread already produced or links it; `statement_lump` means a card or bank
 * booking holds it as one unitemized line. The coordinator confirms the same
 * order from the Email's own content (identifier, lines, total, date).
 */
export type ExistingOrderCandidate = {
  id: ShortcodeFor<"purchase">;
  basis: "thread" | "statement_lump";
  orderId: string | null;
  date: string | null;
  /** The Purchase's printed total, or the lump line's amount. */
  amount: number | null;
};

const line = alias(expense, "candidate_line");

/**
 * Existing-order candidates for one retained Email at its sender-proven
 * Vendor: Purchases linked from other Emails in its thread, and statement
 * lump Purchases near its date. Both are read-only hints for the coordinator.
 * `limit` bounds only a display; the prepare guard reads every candidate, and
 * `lumpAmount` keeps only lumps of that exact total before any limit.
 */
export async function readExistingOrderCandidates(
  db: Database,
  input: {
    ledgerPartyId: LedgerPartyId;
    vendorId: VendorId;
    mailboxId: string;
    messageId: string;
    threadId: string | null;
    receivedAt: Date | null;
  },
  options: { limit?: number; lumpAmount?: number | null } = {},
): Promise<ExistingOrderCandidate[]> {
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  const database = getDb(db);
  const ownAccount = or(
    isNull(vendorAccount.id),
    eq(vendorAccount.ledgerPartyId, input.ledgerPartyId),
  );
  const siblings = input.threadId
    ? await database
        .select({ id: emailTable.id })
        .from(emailTable)
        .where(
          and(
            eq(emailTable.ledgerPartyId, input.ledgerPartyId),
            eq(emailTable.provider, "gmail"),
            eq(emailTable.mailboxId, input.mailboxId),
            eq(emailTable.threadId, input.threadId),
            ne(emailTable.messageId, input.messageId),
            notDeleted(emailTable),
          ),
        )
    : [];
  const thread = siblings.length
    ? await database
        .select({
          shortcode: purchase.shortcode,
          orderId: purchase.orderId,
          date: purchase.date,
          statedTotal: purchase.statedTotal,
        })
        .from(purchase)
        .leftJoin(
          vendorAccount,
          and(
            eq(vendorAccount.id, purchase.vendorAccountId),
            notDeleted(vendorAccount),
          ),
        )
        .where(
          and(
            eq(purchase.vendorId, input.vendorId),
            notDeleted(purchase),
            ownAccount,
            sql`${purchase.id} IN (
              SELECT association."purchaseId" FROM "Email"
              CROSS JOIN LATERAL (${emailPurchaseAssociationsSql()}) association
              WHERE "Email"."id" IN (${sql.join(
                siblings.map((row) => sql`${row.id}`),
                sql`, `,
              )})
            )`,
          ),
        )
        .orderBy(purchase.date, purchase.shortcode)
        .limit(limit)
    : [];
  const liveLines = and(eq(line.purchaseId, purchase.id), notDeleted(line));
  const lumpAmount =
    options.lumpAmount === undefined
      ? undefined
      : options.lumpAmount === null
        ? null
        : Math.round(options.lumpAmount * 100) / 100;
  const lumps =
    input.receivedAt && lumpAmount !== null
      ? await database
          .select({
            shortcode: purchase.shortcode,
            orderId: purchase.orderId,
            date: purchase.date,
            amount: sql<number | null>`(${database
              .select({ cost: line.cost })
              .from(line)
              .where(liveLines)
              .limit(1)})`,
          })
          .from(purchase)
          .leftJoin(
            vendorAccount,
            and(
              eq(vendorAccount.id, purchase.vendorAccountId),
              notDeleted(vendorAccount),
            ),
          )
          .where(
            and(
              eq(purchase.vendorId, input.vendorId),
              notDeleted(purchase),
              ownAccount,
              between(
                purchase.date,
                shiftPlainDate(
                  householdLocalDate(input.receivedAt),
                  -LUMP_DAYS_BEFORE,
                ),
                shiftPlainDate(
                  householdLocalDate(input.receivedAt),
                  LUMP_DAYS_AFTER,
                ),
              ),
              // Accepted import sources already itemize; only a bare booking qualifies.
              notExists(
                database
                  .select({ id: importSourceOrder.id })
                  .from(importSourceOrder)
                  .where(eq(importSourceOrder.purchaseId, purchase.id)),
              ),
              exists(
                database
                  .select({ id: financialTransactionAllocation.id })
                  .from(financialTransactionAllocation)
                  .where(
                    and(
                      eq(
                        financialTransactionAllocation.purchaseId,
                        purchase.id,
                      ),
                      notDeleted(financialTransactionAllocation),
                    ),
                  ),
              ),
              // Exactly one live line, and it is a productless principal booking.
              eq(
                sql`(${database
                  .select({ lines: count() })
                  .from(line)
                  .where(liveLines)})`,
                1,
              ),
              exists(
                database
                  .select({ id: line.id })
                  .from(line)
                  .where(
                    and(
                      liveLines,
                      eq(line.lineKind, expenseLineKindSchema.enum.principal),
                      isNull(line.productId),
                      eq(
                        line.economicRole,
                        expenseEconomicRoleSchema.enum.vendor,
                      ),
                      eq(line.future, false),
                      lumpAmount === undefined
                        ? undefined
                        : sql`round(${line.cost}::numeric, 2) = ${lumpAmount}::numeric`,
                    ),
                  ),
              ),
            ),
          )
          .orderBy(purchase.date, purchase.shortcode)
          .limit(limit)
      : [];
  return [
    ...thread.map((row) => ({
      id: parseShortcodeFor("purchase", row.shortcode),
      basis: "thread" as const,
      orderId: row.orderId,
      date: row.date,
      amount: row.statedTotal === null ? null : minorToMoney(row.statedTotal),
    })),
    ...lumps.map((row) => ({
      id: parseShortcodeFor("purchase", row.shortcode),
      basis: "statement_lump" as const,
      orderId: row.orderId,
      date: row.date,
      amount: row.amount === null ? null : Number(row.amount),
    })),
  ];
}
