import type {
  ExtractedPaymentEvidence,
  ExtractedPurchaseLine,
  ExtractedOrderCandidate,
} from "@cubby/schemas/purchase-import";
import { cents } from "@cubby/shared";

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
        amount: cents(line.amount),
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

const linesTotal = (lines: ExtractedPurchaseLine[]): number =>
  lines.reduce((total, line) => total + cents(line.amount), 0);

/**
 * Import lines may replace only the one legacy aggregate shape that the human
 * purchase workflow created. Anything linked, split, source-claimed, or with a
 * different amount is evidence that deserves review instead of guesswork.
 */
export const decideLineWrite = (
  existing: ExistingExpenseSnapshot[],
  extracted: ExtractedPurchaseLine[],
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
    JSON.stringify(roster(existing)) === JSON.stringify(roster(extracted))
  ) {
    const unused = [...extracted];
    for (const row of existing) {
      const match = unused.findIndex(
        (line) =>
          line.title.trim().replace(/\s+/gu, " ") ===
            row.title.trim().replace(/\s+/gu, " ") &&
          row.amount !== null &&
          cents(line.amount) === cents(row.amount) &&
          line.lineKind === row.lineKind &&
          (row.productQuantity == null ||
            line.quantity === undefined ||
            line.quantity === row.productQuantity),
      );
      if (match < 0) return { kind: "conflict", reason: "duplicate_lines" };
      unused.splice(match, 1);
    }
    return { kind: "no_op" };
  }

  const [aggregate] = existing;
  if (
    existing.length === 1 &&
    aggregate !== undefined &&
    aggregate.lineKind === "principal" &&
    aggregate.productId === null &&
    !aggregate.sourceClaimed &&
    aggregate.amount !== null &&
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
};

export type PaymentAllocation = {
  transactionId: string;
  paymentIndex: number;
  amount: number;
};

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
