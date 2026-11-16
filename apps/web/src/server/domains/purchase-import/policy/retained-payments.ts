import { type PaymentTender } from "@cubby/schemas/purchase-import";

import type { purchasePaymentEvidence } from "~/server/db/retained-tables";

export type RetainedPayment = Readonly<
  Pick<
    typeof purchasePaymentEvidence.$inferSelect,
    "amountMinor" | "chargedAt" | "cardLastFour" | "tender"
  >
>;

export type RetainedPaymentRow = RetainedPayment &
  Pick<typeof purchasePaymentEvidence.$inferSelect, "sourceClaimId">;

// Sources record the same payment at different precision (a full timestamp
// and card on the page, a date only in an export), so they agree on amount
// and charge day.
// The UTC day on purpose: date-only sources arrive as UTC-midnight
// timestamps, and the deferred-settlement SQL compares `chargedAt::date`.
const paymentKey = (payment: RetainedPayment) =>
  // oxlint-disable-next-line cubby/no-ad-hoc-calendar-day -- same UTC day as the SQL side
  `${payment.amountMinor}|${payment.chargedAt?.toISOString().slice(0, 10) ?? ""}`;

export function normalizePaymentSet(
  rows: readonly RetainedPaymentRow[],
): RetainedPayment[] | "conflicting_sources" {
  const bySource = new Map<string, RetainedPayment[]>();
  for (const row of rows) {
    const set = bySource.get(row.sourceClaimId ?? "unclaimed") ?? [];
    set.push(row);
    bySource.set(row.sourceClaimId ?? "unclaimed", set);
  }
  const sets = [...bySource.values()];
  const signature = (set: RetainedPayment[]) =>
    set.map(paymentKey).sort().join(";");
  const [first] = sets;
  if (!first) return [];
  if (!sets.every((set) => signature(set) === signature(first)))
    return "conflicting_sources";
  // Agreeing sources may differ in what they say paid: an order page omits a
  // tender that the export names. A known tender is never left as a wildcard.
  const knownTender = new Map<string, PaymentTender>();
  const knownCard = new Map<string, string>();
  for (const payment of sets.flat()) {
    const key = paymentKey(payment);
    if (payment.tender !== "unknown") {
      const previous = knownTender.get(key);
      if (previous && previous !== payment.tender) return "conflicting_sources";
      knownTender.set(key, payment.tender);
    }
    if (payment.cardLastFour) {
      const previous = knownCard.get(key);
      if (previous && previous !== payment.cardLastFour)
        return "conflicting_sources";
      knownCard.set(key, payment.cardLastFour);
    }
  }
  return first.map((payment) => ({
    ...payment,
    tender: knownTender.get(paymentKey(payment)) ?? payment.tender,
    cardLastFour: knownCard.get(paymentKey(payment)) ?? payment.cardLastFour,
  }));
}

/**
 * A wholly undated payment set stands at its order date: charges for such
 * orders post within the posting window of the order date. A dated line keeps
 * its instant, and its undated siblings stay bounded by it. Without either
 * there is no window, and an amount alone is coincidence, not evidence.
 */
export const anchorPayments = (
  payments: readonly RetainedPayment[],
  orderDate: string | null,
): RetainedPayment[] =>
  !orderDate || payments.some((payment) => payment.chargedAt)
    ? [...payments]
    : payments.map((payment) => ({
        ...payment,
        chargedAt: new Date(`${orderDate}T12:00:00.000Z`),
      }));
