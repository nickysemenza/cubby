import type {
  ExtractedPaymentEvidence,
  ExtractedPurchaseLine,
} from "@cubby/schemas/purchase-import";

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
};

export type LineWriteDecision =
  | { kind: "insert"; lines: ExtractedPurchaseLine[] }
  | {
      kind: "replace_aggregate";
      aggregate: ExistingExpenseSnapshot;
      lines: ExtractedPurchaseLine[];
    }
  | { kind: "no_op" }
  | { kind: "conflict"; reason: "duplicate_lines" };

const cents = (amount: number): number => Math.round(amount * 100);

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
    return { kind: "replace_aggregate", aggregate, lines: extracted };
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

export type OrderAmountCandidate = {
  id: string;
  amount: number;
};

/** Finds a unique, bounded subset of distinct orders for a combined charge. */
export const uniqueOrderSubsetForCharge = (
  chargeAmount: number,
  orders: OrderAmountCandidate[],
  maxOrders = 8,
): OrderAmountCandidate[] | null => {
  const target = cents(chargeAmount);
  const bounded = orders.slice(0, maxOrders);
  const matches: OrderAmountCandidate[][] = [];

  const visit = (
    index: number,
    sum: number,
    chosen: OrderAmountCandidate[],
  ) => {
    if (matches.length > 1) return;
    if (sum === target && chosen.length > 0) {
      matches.push([...chosen]);
      return;
    }
    if (index >= bounded.length || sum > target) return;

    visit(index + 1, sum, chosen);
    const order = bounded[index];
    if (order === undefined) return;
    chosen.push(order);
    visit(index + 1, sum + cents(order.amount), chosen);
    chosen.pop();
  };

  visit(0, 0, []);
  return matches.length === 1 ? (matches[0] ?? null) : null;
};
