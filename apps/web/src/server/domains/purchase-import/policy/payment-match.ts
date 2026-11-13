import type { PaymentTender } from "@cubby/schemas/purchase-import";

import { withinPostingInstantWindow } from "~/server/domains/financial-transaction/policy/settlement-window";
export type PaymentMatchRead = {
  amountMinor: bigint;
  chargedAt: Date | null;
  cardLastFour: string | null;
  tender: PaymentTender;
};
export type ChargeMatchRead = {
  id: string;
  amountMinor: bigint;
  occurredAt: Date;
  cardLastFours: readonly string[];
  storedValue: boolean;
};
/** Reads: the whole retained payment set and eligible charge candidate set; missing candidates reject the entire match. Input order is retained. */
export function completePaymentMatches(
  payments: readonly PaymentMatchRead[],
  candidates: readonly ChargeMatchRead[],
) {
  const unused = new Map(candidates.map((row) => [row.id, row]));
  const allocations: {
    transactionId: string;
    paymentIndex: number;
    amountMinor: bigint;
  }[] = [];
  for (const [paymentIndex, payment] of payments.entries()) {
    const matches = [...unused.values()].filter(
      (charge) =>
        charge.amountMinor === payment.amountMinor &&
        (payment.tender === "stored_value"
          ? charge.storedValue
          : payment.tender === "card"
            ? !charge.storedValue
            : true) &&
        (payment.cardLastFour === null ||
          charge.cardLastFours.includes(payment.cardLastFour)) &&
        (payment.chargedAt === null ||
          withinPostingInstantWindow(charge.occurredAt, payment.chargedAt)),
    );
    const [match] = matches;
    if (matches.length !== 1 || !match) return null;
    unused.delete(match.id);
    allocations.push({
      transactionId: match.id,
      paymentIndex,
      amountMinor: payment.amountMinor,
    });
  }
  return allocations;
}

/** Reads: Purchase vendorId/statedTotalMinor/date, its first source-claim owner, normalized retained payment set and all eligible charges (including the prospective charge). */
export function groupMemberNamesCharge(input: {
  purchaseVendorId: string | null;
  vendorId: string;
  statedTotalMinor: bigint | null;
  ownerId: string | null;
  ledgerPartyId: string;
  chargeId: string;
  amountMinor: bigint;
  payments: readonly PaymentMatchRead[] | "conflicting_sources";
  charges: readonly ChargeMatchRead[];
}) {
  if (
    input.purchaseVendorId !== input.vendorId ||
    input.statedTotalMinor === null ||
    input.statedTotalMinor <= 0n ||
    input.ownerId !== input.ledgerPartyId ||
    input.payments === "conflicting_sources" ||
    input.payments.length !== 1 ||
    input.payments[0]?.amountMinor !== input.amountMinor
  )
    return false;
  return (
    completePaymentMatches(input.payments, input.charges)?.[0]
      ?.transactionId === input.chargeId
  );
}
