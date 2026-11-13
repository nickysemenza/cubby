import type {
  FinancialSpendingAdvice,
  financialSpendingSource,
} from "@cubby/schemas/financial-booking";
import type { z } from "zod";

import {
  liveHouseholdSpendingAccount,
  liveHouseholdLoan,
} from "~/server/domains/financial-account/policy/purchaser";
import { statementEffectiveMovement } from "~/server/domains/transaction-import/policy/statement-effective-movement";
export type SpendingPrerequisiteFacts = {
  source: Omit<z.infer<typeof financialSpendingSource>, "amount"> & {
    amountMinor: bigint;
  };
  account: NonNullable<Parameters<typeof liveHouseholdLoan>[0]>;
  purchaser: { shortcode: string } | null;
};
export function spendingBlocker(input: {
  facts: SpendingPrerequisiteFacts;
  advice: FinancialSpendingAdvice | null;
  vendorResolved: boolean;
  ambiguous: boolean;
}) {
  const { facts, advice } = input;
  if (issuerCardFee(facts) && !input.vendorResolved)
    return "The card account needs a live issuer Vendor before booking this fee.";
  const escrow =
    liveHouseholdLoan(facts.account) &&
    facts.source.kind === "purchase" &&
    facts.source.amountMinor > 0n &&
    statementEffectiveMovement({
      providerAmountMinor: facts.source.amountMinor,
      description: facts.source.rawDescription,
      merchant: facts.source.merchant,
      sourceCategory: null,
      loan: { providerVendorNames: [], proven: true },
    }).movementClass === "escrow_disbursement" &&
    advice?.escrowDisbursement === true;
  const escrowRefund =
    liveHouseholdLoan(facts.account) &&
    facts.source.kind === "refund" &&
    facts.source.amountMinor < 0n &&
    statementEffectiveMovement({
      providerAmountMinor: facts.source.amountMinor,
      description: facts.source.rawDescription,
      merchant: facts.source.merchant,
      sourceCategory: null,
      loan: { providerVendorNames: [], proven: true },
    }).movementClass === "escrow_refund";
  if (facts.account.identity.kind === "loan" && !escrow && !escrowRefund)
    return "Only a supported household loan escrow disbursement can book spending.";
  if (
    !facts.purchaser &&
    !liveHouseholdSpendingAccount(facts.account) &&
    !escrow &&
    !escrowRefund
  )
    return "A confirmed member-owned account or household card, bank or stored-value account is required before booking spending.";
  if (
    !(facts.source.transactionDate ?? facts.source.postedDate) ||
    !facts.source.sourceRefs.length
  )
    return "A dated, stable source identity is required before booking spending.";
  if (input.ambiguous)
    return "The merchant matches competing Vendors; review its identity.";
  if (
    !input.vendorResolved &&
    (!advice?.vendorName ||
      advice.vendorConfidence !== "high" ||
      advice.counterparty !== "business")
  )
    return "The merchant needs a supported business name before a Vendor can be created.";
  if (
    !issuerCardFee(facts) &&
    (advice?.counterparty === "person" ||
      advice?.counterparty === "payment_processor")
  )
    return "The counterparty does not identify a business Vendor.";
  return null;
}

/** Standard card fee descriptions identify the issuer, not a merchant. */
export function issuerCardFee(facts: SpendingPrerequisiteFacts) {
  if (
    facts.account.identity.kind !== "credit_card" ||
    facts.source.kind !== "fee"
  )
    return false;
  return [facts.source.merchant, facts.source.rawDescription].some((value) =>
    /^(foreign transaction fee|annual membership fee|renewal membership fee|membership fee|return payment fee|monthly service fee)$/i.test(
      value?.trim() ?? "",
    ),
  );
}
