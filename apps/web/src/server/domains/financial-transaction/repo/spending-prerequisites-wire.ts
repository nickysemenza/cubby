import type { financialSpendingSource } from "@cubby/schemas/financial-booking";
import { moneyToMinor } from "@cubby/shared";
import type { z } from "zod";

import {
  spendingBlocker as blocker,
  issuerCardFee as fee,
  type SpendingPrerequisiteFacts as MinorFacts,
} from "~/server/domains/financial-transaction/policy/spending-prerequisites";
type Facts = Omit<MinorFacts, "source"> & {
  source: z.infer<typeof financialSpendingSource>;
};
const minorFacts = (facts: Facts): MinorFacts => {
  const { amount, ...source } = facts.source;
  return { ...facts, source: { ...source, amountMinor: moneyToMinor(amount) } };
};
export function spendingBlocker(
  input: Omit<Parameters<typeof blocker>[0], "facts"> & { facts: Facts },
) {
  return blocker({ ...input, facts: minorFacts(input.facts) });
}
export function issuerCardFee(facts: Facts) {
  return fee(minorFacts(facts));
}
