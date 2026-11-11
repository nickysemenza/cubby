import { mailEvent } from "@cubby/schemas/mailbox-research";
import type {
  ExtractedPaymentEvidence,
  ExtractedPurchaseLine,
  ExtractedOrderCandidate,
} from "@cubby/schemas/purchase-import";
import { cents } from "@cubby/shared";
import { eq, sql, type SQL } from "drizzle-orm";

import {
  importSourceOrder,
  importSourceProduct,
} from "~/server/db/generated/entity-table-definitions.gen";
import { notDeleted } from "~/server/db/helpers";
import { related } from "~/server/db/helpers/related";

/** Cosmetic evidence changes cannot replace accepted ledger or payment rows. */
export const sourceFinancialFacts = (candidate: ExtractedOrderCandidate) => {
  const text = (value: string | undefined) =>
    value?.trim().replace(/\s+/gu, " ") ?? null;
  const sorted = (values: unknown[]) =>
    values.map((value) => JSON.stringify(value)).sort();
  return {
    orderId: candidate.orderId,
    orderedAt: candidate.orderedAt?.includes("T")
      ? new Date(candidate.orderedAt).toISOString()
      : candidate.orderedAt,
    currency: candidate.currency,
    total:
      candidate.printedGrandTotal === null
        ? null
        : cents(candidate.printedGrandTotal),
    lines: sorted(
      candidate.lines.map((line) => ({
        title: text(line.title),
        amount: line.amount === null ? null : cents(line.amount),
        lineKind: line.lineKind,
        quantity: line.quantity ?? null,
        sku: text(line.sku),
        seller: text(line.seller),
      })),
    ),
    payments: sorted(
      candidate.payments.map((payment) => ({
        amount: cents(payment.amount),
        chargedAt: payment.chargedAt
          ? new Date(payment.chargedAt).toISOString()
          : null,
        cardLastFour: payment.cardLastFour ?? null,
      })),
    ),
  };
};

export type ExistingExpenseSnapshot = {
  id: string;
  title: string;
  amount: number | null;
  lineKind: string;
  productId: string | null;
  tradeId: string | null;
  projectId: string | null;
  costType: string | null;
  sourceClaimed: boolean;
  lineBasis?: string;
  productQuantity?: number | null;
};

export type LineWriteDecision =
  | { kind: "insert"; lines: ExtractedPurchaseLine[] }
  | {
      kind: "review_aggregate";
      aggregate: ExistingExpenseSnapshot;
      lines: ExtractedPurchaseLine[];
    }
  | { kind: "no_op" }
  | { kind: "conflict"; reason: "duplicate_lines" };

/** Null when any line is unpriced: unpriced lines never sum to a known total. */
const linesTotal = (lines: ExtractedPurchaseLine[]): number | null =>
  lines.some((line) => line.amount === null)
    ? null
    : lines.reduce((total, line) => total + cents(line.amount ?? 0), 0);

export const sameLineTitle = (left: string, right: string) =>
  left.trim().replace(/\s+/gu, " ") === right.trim().replace(/\s+/gu, " ");

/** Original amounts describe evidence, independent of the USD Expense valuation. */
export const originalItemFacts = (candidate: ExtractedOrderCandidate) => ({
  currency: candidate.currency,
  total: candidate.printedGrandTotal,
  lines: candidate.lines.map(({ title, amount, quantity, lineKind }) => ({
    title,
    amount,
    quantity: quantity ?? null,
    lineKind,
  })),
});

/** Eligible original evidence, independent of its USD ledger valuation. */
export const foreignReceiptSourceSql = (
  original: SQL,
): SQL<boolean> => sql<boolean>`(
  ${original} #>> '{extraction,candidate,currency}' <> 'USD'
  AND ${original} #>> '{extraction,candidate,currency}' ~ '^[A-Z]{3}$'
  AND COALESCE(${original} #>> '{extraction,candidate,sourceEvent}', '') NOT IN (${mailEvent.enum.refunded}, ${mailEvent.enum.cancelled})
)`;

/** A USD order that printed its total and item names but no item prices. */
const unpricedItemizationSourceSql = (original: SQL): SQL<boolean> =>
  sql<boolean>`(${original} #>> '{extraction,status}' = ${"needs_review"}
  AND ${original} #>> '{extraction,reason}' = ${"unpriced_itemization"})`;

/**
 * Pricing protection follows immutable provenance, even after
 * moving/reclassifying the Expense: a foreign receipt line, or an unpriced
 * itemization line whose money its aggregate Expense already carries.
 */
export const foreignExpenseOriginSql = (expenseId: SQL): SQL<boolean> =>
  related(importSourceProduct, (binding) => eq(binding.expenseId, expenseId))
    .join(
      importSourceOrder,
      (order, binding) => sql`${order.id} = ${binding.sourceOrderId}
  AND ((${order.originalOrder} #>> '{extraction,candidate,currency}' IS NOT NULL
  AND ${order.originalOrder} #>> '{extraction,candidate,currency}' <> 'USD')
  OR ${unpricedItemizationSourceSql(order.originalOrder)})`,
    )
    .exists();

/** Coverage requires the current item still to belong to the original Purchase and role. */
export const foreignReceiptExpenseSql = (row: {
  id: SQL;
  purchaseId: SQL;
  lineKind: SQL;
}): SQL<boolean> =>
  related(importSourceProduct, (binding) => eq(binding.expenseId, row.id))
    .join(
      importSourceOrder,
      (order, binding) => sql`${order.id} = ${binding.sourceOrderId}
  AND ${order.purchaseId} = ${row.purchaseId} AND ${foreignReceiptSourceSql(order.originalOrder)}
  AND (${order.originalOrder} #> '{extraction,candidate,lines}') -> ${binding.lineIndex} ->> ${"lineKind"} = ${row.lineKind}`,
    )
    .exists();

/** An unpriced item line of an unpriced USD itemization, still on its original Purchase and role. */
const unpricedItemizationExpenseSql = (row: {
  id: SQL;
  purchaseId: SQL;
  lineKind: SQL;
}): SQL<boolean> =>
  related(importSourceProduct, (binding) => eq(binding.expenseId, row.id))
    .join(
      importSourceOrder,
      (order, binding) => sql`${order.id} = ${binding.sourceOrderId}
  AND ${order.purchaseId} = ${row.purchaseId} AND ${unpricedItemizationSourceSql(order.originalOrder)}
  AND (${order.originalOrder} #> '{extraction,candidate,lines}') -> ${binding.lineIndex} ->> ${"lineKind"} = ${row.lineKind}
  AND EXISTS (
    SELECT 1 FROM "Expense" carried
    WHERE carried."purchaseId" = ${row.purchaseId} AND ${notDeleted("carried")}
      AND carried."lineBasis" = ${"allocation"}
      AND carried.cost = (${order.originalOrder} #>> '{extraction,candidate,printedGrandTotal}')::numeric
  )`,
    )
    .exists();

/**
 * An unpriced item line whose money is carried elsewhere by source provenance:
 * a foreign receipt line beside its USD settlement, or an unpriced
 * itemization line beside its printed-total aggregate. Sums and settlement
 * skip it rather than treat the Purchase as partly priced.
 */
export const unpricedForeignExpenseSql = (row: {
  id: SQL;
  purchaseId: SQL;
  lineKind: SQL;
  cost: SQL;
}): SQL<boolean> =>
  sql<boolean>`(${row.cost} IS NULL AND (${foreignReceiptExpenseSql(row)} OR ${unpricedItemizationExpenseSql(row)}))`;

export const importedLineMatchesExpense = (
  row: Pick<
    ExistingExpenseSnapshot,
    "title" | "amount" | "lineKind" | "productQuantity"
  >,
  line: ExtractedPurchaseLine,
  valuation: "USD" | "unknown" = "USD",
) =>
  sameLineTitle(line.title, row.title) &&
  (valuation === "unknown"
    ? row.amount === null
    : row.amount !== null &&
      line.amount !== null &&
      cents(line.amount) === cents(row.amount)) &&
  line.lineKind === row.lineKind &&
  (row.productQuantity == null ||
    line.quantity === undefined ||
    line.quantity === row.productQuantity);

/**
 * Import lines may replace only the one legacy aggregate shape that the human
 * purchase workflow created. Anything linked, split, source-claimed, or with a
 * different amount is evidence that deserves review instead of guesswork.
 */
export const decideLineWrite = (
  existing: ExistingExpenseSnapshot[],
  extracted: ExtractedPurchaseLine[],
  valuation: "USD" | "unknown" = "USD",
): LineWriteDecision => {
  if (extracted.length === 0) return { kind: "no_op" };
  if (existing.length === 0) return { kind: "insert", lines: extracted };
  const roster = (
    values: readonly {
      title: string;
      amount: number | null;
      lineKind: string;
    }[],
  ) =>
    values
      .map((line) =>
        JSON.stringify([
          line.title.trim().replace(/\s+/gu, " "),
          line.amount === null ? null : cents(line.amount),
          line.lineKind,
        ]),
      )
      .sort();
  if (
    existing.every(
      (line) => line.lineBasis === "item_line" || line.sourceClaimed,
    ) &&
    JSON.stringify(roster(existing)) ===
      JSON.stringify(
        roster(
          extracted.map((line) => ({
            ...line,
            amount: valuation === "unknown" ? null : line.amount,
          })),
        ),
      )
  ) {
    const unused = [...extracted];
    for (const row of existing) {
      const match = unused.findIndex((line) =>
        importedLineMatchesExpense(row, line, valuation),
      );
      if (match < 0) return { kind: "conflict", reason: "duplicate_lines" };
      unused.splice(match, 1);
    }
    return { kind: "no_op" };
  }

  const [aggregate] = existing;
  if (
    valuation === "USD" &&
    existing.length === 1 &&
    aggregate !== undefined &&
    aggregate.lineKind === "principal" &&
    aggregate.productId === null &&
    !aggregate.sourceClaimed &&
    aggregate.amount !== null &&
    linesTotal(extracted) !== null &&
    cents(aggregate.amount) === linesTotal(extracted)
  ) {
    return { kind: "review_aggregate", aggregate, lines: extracted };
  }

  return { kind: "conflict", reason: "duplicate_lines" };
};

export type SettlementCandidate = {
  id: string;
  amount: number;
  occurredAt: Date;
  /** Every last four the paying account could have presented on that date. */
  cardLastFours: readonly string[];
  /** The paying account is a gift card, account balance or store credit. */
  storedValue: boolean;
};

export type PaymentAllocation = {
  transactionId: string;
  paymentIndex: number;
  amount: number;
};

// A missing last four is not a wildcard across tenders: a gift-card line paid
// nothing on any card, so it settles only against a stored-value account.
const tenderAdmits = (
  tender: ExtractedPaymentEvidence["tender"],
  storedValue: boolean,
): boolean =>
  tender === "stored_value"
    ? storedValue
    : tender === "card"
      ? !storedValue
      : true;

const withinPostingWindow = (a: Date, b: Date): boolean =>
  Math.abs(a.getTime() - b.getTime()) <= 3 * 86_400_000;

/**
 * Returns only complete allocation sets. A transaction is never partly
 * allocated: callers either persist this whole result in one transaction or
 * persist nothing.
 */
export const matchCompletePaymentSet = (
  payments: ExtractedPaymentEvidence[],
  candidates: SettlementCandidate[],
): PaymentAllocation[] | null => {
  const unused = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const allocations: PaymentAllocation[] = [];

  for (const [paymentIndex, payment] of payments.entries()) {
    const chargedAt = payment.chargedAt ? new Date(payment.chargedAt) : null;
    const matches = [...unused.values()].filter(
      (candidate) =>
        cents(candidate.amount) === cents(payment.amount) &&
        tenderAdmits(payment.tender, candidate.storedValue) &&
        (payment.cardLastFour === undefined ||
          candidate.cardLastFours.includes(payment.cardLastFour)) &&
        (chargedAt === null ||
          withinPostingWindow(candidate.occurredAt, chargedAt)),
    );
    if (matches.length !== 1) return null;
    const match = matches[0];
    if (match === undefined) return null;
    unused.delete(match.id);
    allocations.push({
      transactionId: match.id,
      paymentIndex,
      amount: payment.amount,
    });
  }

  return allocations;
};
