import type { FinancialBookingPreview } from "@cubby/schemas/financial-booking";

/**
 * Reads: FinancialTransaction amountMinor/shortcode and effective date/name;
 * FinancialAccount/LedgerParty resolved purchaser; Vendor resolved shortcode;
 * Expense effective category, role, cost type, trade and beneficiary decisions;
 * FinancialTransactionAllocation eligible same-direction remaining booked cents.
 * Missing Purchase is explicit and creates one bare Purchase without order facts.
 */
export function statementBookingRows(input: {
  charge: {
    transactionId: FinancialBookingPreview["transactionId"];
    amountMinor: bigint;
    date: string;
    name: string;
  };
  purchaseId: FinancialBookingPreview["purchaseId"];
  purchaserId: FinancialBookingPreview["purchaserId"];
  vendorId: FinancialBookingPreview["vendorId"];
  categoryOverride: FinancialBookingPreview["categoryOverride"];
  economicRole: FinancialBookingPreview["economicRole"];
  costType: FinancialBookingPreview["costType"];
  trade: FinancialBookingPreview["trade"];
  beneficiaries: FinancialBookingPreview["beneficiaries"];
  confirmsMerchant: FinancialBookingPreview["confirmsMerchant"];
  remainingBookedMinor: bigint;
}) {
  const abs = (value: bigint) => (value < 0n ? -value : value);
  const createAggregate =
    input.economicRole !== "vendor" ||
    abs(input.remainingBookedMinor) < abs(input.charge.amountMinor);
  return {
    purchase: input.purchaseId
      ? null
      : {
          vendorId: input.vendorId,
          defaultTrade: input.trade,
          date: input.charge.date,
          displayLabel: input.charge.name,
          purchaserOverrideId: input.purchaserId,
        },
    expense: createAggregate
      ? {
          name: input.charge.name,
          costMinor: input.charge.amountMinor,
          date: input.charge.date,
          spendingCategoryId: input.categoryOverride,
          economicRole: input.economicRole,
          costType: input.costType,
          trade: input.trade,
          lineKind: "principal" as const,
          lineBasis: "allocation" as const,
          bookingTransactionCode: input.charge.transactionId,
          attributions: (input.beneficiaries ?? []).map((share) => ({
            role: "beneficiary" as const,
            partyId: share.partyId,
            weight: share.weight,
          })),
          beneficiariesSpecified: input.beneficiaries !== undefined,
        }
      : null,
    allocation: {
      amountMinor: input.charge.amountMinor,
      confirmsMerchant: input.confirmsMerchant,
    },
  };
}
