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
