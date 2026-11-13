import { moneyToMinor } from "@cubby/shared";

import type { sourceOrderObservation } from "~/server/db/retained-tables";
import { normalizeOrderKey } from "~/server/domains/purchase-import/policy/order-identity";

/** Every payer uses the same exact USD movement key, before either side exists. */
export const paymentAmountKey = (amount: bigint) =>
  `payment:amount:USD:${amount}`;
export const orderEventKey = (
  row: Pick<
    typeof sourceOrderObservation.$inferSelect,
    "ledgerPartyId" | "vendorId" | "orderKey" | "extraction"
  >,
) =>
  row.extraction.candidate?.orderId
    ? `order:${row.ledgerPartyId}:${row.vendorId}/order/${normalizeOrderKey(row.extraction.candidate.orderId)}`
    : `order:${row.ledgerPartyId}:${row.orderKey}`;
export const paymentOrderKey = (vendorId: string, orderId: string) =>
  `payment:order:${vendorId}:${normalizeOrderKey(orderId)}`;

export const orderPaymentKeys = (
  row: Pick<
    typeof sourceOrderObservation.$inferSelect,
    "vendorId" | "extraction"
  >,
): string[] => {
  const candidate = row.extraction.candidate;
  if (!candidate) return [];
  return [
    ...new Set([
      ...(candidate.orderId
        ? [paymentOrderKey(row.vendorId, candidate.orderId)]
        : []),
      ...(candidate.currency === "USD"
        ? candidate.payments.map((payment) =>
            paymentAmountKey(moneyToMinor(payment.amount)),
          )
        : []),
    ]),
  ];
};

/** Bank record identities cannot collide with purchase-event scope keys during merges. */
export const paymentBankEventKey = (id: string) => `bank:${id}`;
