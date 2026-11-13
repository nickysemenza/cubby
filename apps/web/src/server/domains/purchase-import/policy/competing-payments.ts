import type { PurchaseId } from "@cubby/schemas/identifiers";
import type { PaymentTender } from "@cubby/schemas/purchase-import";

/**
 * Reads: live Purchase id; every same-amount PurchasePaymentEvidence row's
 * purchaseId/amountMinor/chargedAt/tender/cardLastFour, and all payment and live
 * allocation amountMinor totals of each sign for that Purchase, across sources.
 * An empty same-amount search proves no claimant; there is no owner/Vendor filter.
 */
export function competingPaymentClaimants(
  input: {
    amountMinor: bigint;
    occurredAt: Date;
    storedValue: boolean;
    cardLastFours: readonly string[];
  },
  rows: readonly {
    purchaseId: PurchaseId;
    chargedAt: Date | null;
    tender: PaymentTender;
    cardLastFour: string | null;
    paidMinor: bigint;
    evidenceMinor: bigint;
  }[],
): PurchaseId[] {
  const abs = (value: bigint) => (value < 0n ? -value : value);
  const anchor = Math.floor(input.occurredAt.getTime() / 1000) * 1000;
  return [
    ...new Set(
      rows
        .filter(
          (row) =>
            (row.chargedAt === null ||
              Math.abs(row.chargedAt.getTime() - anchor) <= 3 * 86_400_000) &&
            (input.storedValue
              ? row.tender !== "card"
              : row.tender !== "stored_value") &&
            (!input.cardLastFours.length ||
              row.cardLastFour === null ||
              input.cardLastFours.includes(row.cardLastFour)) &&
            abs(row.paidMinor) < abs(row.evidenceMinor),
        )
        .map((row) => row.purchaseId),
    ),
  ];
}
