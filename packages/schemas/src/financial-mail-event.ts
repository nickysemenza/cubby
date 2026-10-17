import { z } from "zod";
import { plainDate } from "./base-entity";

/** Literal payment evidence. The producer owns checksum, span, attribution and
 * declared-decision verification; a caller's parsed payload grants no authority. */
export const financialMailEvent = z.strictObject({
  kind: z.enum([
    "purchase_payment",
    "refund",
    "incoming_payment",
    "transfer",
    "card_repayment",
    "reimbursement",
  ]),
  amount: z.strictObject({
    minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  sourceAccountLabel: z.string().trim().min(1).nullable(),
  providerEventId: z.string().trim().min(1).nullable(),
  occurredOn: plainDate.nullable(),
  counterpartyLabel: z.string().trim().min(1).nullable(),
});
export type FinancialMailEvent = z.infer<typeof financialMailEvent>;
