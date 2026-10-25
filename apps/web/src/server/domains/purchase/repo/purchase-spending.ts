import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  ExpenseId,
  ExpenseShortcode,
  PurchaseId,
  PurchaseShortcode,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  type SQL,
  sql,
} from "drizzle-orm";
import { groupBy } from "es-toolkit";

import {
  expense,
  financialTransaction,
  financialTransactionAllocation,
  purchase,
} from "~/server/db/generated/entity-table-definitions.gen";
import { vendor } from "~/server/db/generated/identity-storage-tables.gen";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  repositoryQueries as unwrapDb,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { ledgerSourceClaim } from "~/server/db/retained-tables";
import { liveSettlementAllocationWhere } from "~/server/domains/purchase/repo/settlement-predicates";
import {
  buildPurchaseSpendingEvents,
  type PurchaseSpendingEvent,
  type PurchaseSpendingLineInput,
} from "~/server/lib/purchase-spending";

type PurchaseSpendingPurchase = {
  id: PurchaseShortcode;
  title: string;
  date: string | null;
  statedTotal: number | null;
  displayLabel: string | null;
  orderId: string | null;
  vendorId: VendorShortcode;
  vendorName: string | null;
};

/** `id` is the Expense shortcode. */
type PurchaseSpendingLine = PurchaseSpendingLineInput & {
  id: ExpenseShortcode;
  name: string;
};

/**
 * One calendar purchase occurrence. The calendar keys it by
 * `purchase.id`, `occurrence` and `date`; settlement `id`s are
 * FinancialTransaction shortcodes.
 */
export type PurchaseSpendingCalendarEvent = PurchaseSpendingEvent<
  PurchaseSpendingPurchase,
  PurchaseSpendingLine
>;

export type LoadPurchaseSpendingInput = {
  startDate: string;
  endDateExclusive: string;
  /**
   * Expense population predicate. When set, a Purchase qualifies only if any
   * of its live Expenses matches; its events keep their whole amounts.
   */
  expenseCondition?: SQL;
};

const inWindow = (
  value: SQL,
  { startDate, endDateExclusive }: LoadPurchaseSpendingInput,
) => and(gte(value, startDate), lt(value, endDateExclusive));

const allocationDateSql = sql<
  string | null
>`coalesce(${financialTransaction.transactionDate}, ${financialTransaction.postedDate})`;
const claimOccurredOnSql = sql<
  string | null
>`(${ledgerSourceClaim.normalizedEvidence}->>'occurredOn')`;

/**
 * Purchases with any event that can land in the window. An event's date comes
 * from the Purchase date, an Expense date, a refund source-claim date or a
 * settlement date, so a Purchase is a candidate when any of those falls
 * inside; the events are dated afterwards and clipped to the window.
 */
const candidatePurchases = (
  db: RepositoryQueryInput,
  input: LoadPurchaseSpendingInput,
) => {
  const client = unwrapDb(db);
  const byExpense = client
    .select({ purchaseId: expense.purchaseId })
    .from(expense)
    .where(
      and(
        notDeleted(expense),
        isNotNull(expense.purchaseId),
        inWindow(sql`${expense.date}`, input),
      ),
    );
  const byClaim = client
    .select({ purchaseId: expense.purchaseId })
    .from(ledgerSourceClaim)
    .innerJoin(expense, eq(expense.id, ledgerSourceClaim.expenseId))
    .where(
      and(
        notDeleted(ledgerSourceClaim),
        notDeleted(expense),
        isNotNull(expense.purchaseId),
        inWindow(claimOccurredOnSql, input),
      ),
    );
  const bySettlement = client
    .select({ purchaseId: financialTransactionAllocation.purchaseId })
    .from(financialTransactionAllocation)
    .innerJoin(
      financialTransaction,
      eq(financialTransaction.id, financialTransactionAllocation.transactionId),
    )
    .where(
      and(liveSettlementAllocationWhere, inWindow(allocationDateSql, input)),
    );
  const candidateIds = client
    .select({ purchaseId: sql<PurchaseId | null>`${purchase.id}` })
    .from(purchase)
    .where(and(notDeleted(purchase), inWindow(sql`${purchase.date}`, input)))
    .union(byExpense)
    .union(byClaim)
    .union(bySettlement);
  const membership = input.expenseCondition
    ? inArray(
        purchase.id,
        client
          .select({ purchaseId: expense.purchaseId })
          .from(expense)
          .where(and(notDeleted(expense), input.expenseCondition)),
      )
    : undefined;

  return client
    .select({
      uuid: purchase.id,
      shortcode: purchase.shortcode,
      date: purchase.date,
      statedTotal: purchase.statedTotal,
      displayLabel: purchase.displayLabel,
      orderId: purchase.orderId,
      vendorShortcode: vendor.shortcode,
      vendorName: sql<
        string | null
      >`CASE WHEN ${vendor.deletedAt} IS NULL THEN ${vendor.name} END`,
    })
    .from(purchase)
    .innerJoin(vendor, eq(vendor.id, purchase.vendorId))
    .where(
      and(notDeleted(purchase), inArray(purchase.id, candidateIds), membership),
    );
};

const loadLines = async (
  db: RepositoryQueryInput,
  purchaseIds: readonly PurchaseId[],
) => {
  const client = unwrapDb(db);
  const rows = await client
    .select({
      uuid: expense.id,
      purchaseId: expense.purchaseId,
      shortcode: expense.shortcode,
      name: expense.name,
      cost: expense.cost,
      date: expense.date,
      lineKind: expense.lineKind,
      future: expense.future,
    })
    .from(expense)
    .where(
      and(inArray(expense.purchaseId, [...purchaseIds]), notDeleted(expense)),
    );
  // Claim dates only date refund lines, which are always negative.
  const negativeIds = rows
    .filter((row) => row.cost !== null && row.cost < 0)
    .map((row) => row.uuid);
  const claims =
    negativeIds.length === 0
      ? []
      : await client
          .select({
            expenseId: ledgerSourceClaim.expenseId,
            occurredOn: claimOccurredOnSql,
          })
          .from(ledgerSourceClaim)
          .where(
            and(
              inArray(ledgerSourceClaim.expenseId, negativeIds),
              notDeleted(ledgerSourceClaim),
              isNotNull(claimOccurredOnSql),
            ),
          );
  const claimDates = new Map<ExpenseId, string[]>();
  for (const claim of claims) {
    if (!claim.expenseId || !claim.occurredOn) continue;
    claimDates.set(claim.expenseId, [
      ...(claimDates.get(claim.expenseId) ?? []),
      claim.occurredOn,
    ]);
  }
  return rows.map((row) => ({
    purchaseId: row.purchaseId,
    line: {
      id: parseShortcodeFor("expense", row.shortcode),
      name: row.name,
      cost: row.cost,
      date: row.date,
      lineKind: row.lineKind,
      future: row.future,
      claimDates: claimDates.get(row.uuid) ?? [],
    } satisfies PurchaseSpendingLine,
  }));
};

const loadAllocations = (
  db: RepositoryQueryInput,
  purchaseIds: readonly PurchaseId[],
) =>
  unwrapDb(db)
    .select({
      purchaseId: financialTransactionAllocation.purchaseId,
      shortcode: financialTransaction.shortcode,
      kind: financialTransaction.kind,
      amount: financialTransactionAllocation.amount,
      transactionDate: financialTransaction.transactionDate,
      postedDate: financialTransaction.postedDate,
    })
    .from(financialTransactionAllocation)
    .innerJoin(
      financialTransaction,
      eq(financialTransaction.id, financialTransactionAllocation.transactionId),
    )
    .where(
      and(
        inArray(financialTransactionAllocation.purchaseId, [...purchaseIds]),
        liveSettlementAllocationWhere,
      ),
    );

/**
 * Purchase spending events dated inside `[startDate, endDateExclusive)`:
 * one original event per Purchase and one refund event per refund date. Read
 * only; see `~/server/lib/purchase-spending` for amount and date rules.
 */
export async function loadPurchaseSpending(
  db: RepositoryQueryInput,
  input: LoadPurchaseSpendingInput,
): Promise<PurchaseSpendingCalendarEvent[]> {
  const purchases = await candidatePurchases(db, input);
  if (purchases.length === 0) return [];
  const ids = purchases.map((row) => row.uuid);
  const [lines, allocations] = await Promise.all([
    loadLines(db, ids),
    loadAllocations(db, ids),
  ]);
  const linesByPurchase = groupBy(lines, (row) => row.purchaseId ?? "");
  const allocationsByPurchase = groupBy(
    allocations,
    (row) => row.purchaseId ?? "",
  );

  return purchases
    .flatMap((row) => {
      const vendorName = row.vendorName;
      const identity: PurchaseSpendingPurchase = {
        id: parseShortcodeFor("purchase", row.shortcode),
        title: vendorName ?? "Purchase",
        date: row.date,
        statedTotal: row.statedTotal,
        displayLabel: row.displayLabel,
        orderId: row.orderId,
        vendorId: parseShortcodeFor("vendor", row.vendorShortcode),
        vendorName,
      };
      return buildPurchaseSpendingEvents(
        identity,
        (linesByPurchase[row.uuid] ?? []).map(({ line }) => line),
        (allocationsByPurchase[row.uuid] ?? []).map((allocation) => ({
          id: allocation.shortcode,
          kind: allocation.kind,
          amount: allocation.amount,
          transactionDate: allocation.transactionDate,
          postedDate: allocation.postedDate,
        })),
      );
    })
    .filter(
      (event) =>
        event.date >= input.startDate && event.date < input.endDateExclusive,
    )
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.purchase.id.localeCompare(b.purchase.id) ||
        a.occurrence.localeCompare(b.occurrence),
    );
}
