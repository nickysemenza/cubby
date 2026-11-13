import type { PurchaseId } from "@cubby/schemas/identifiers";
/** Reads: each live Purchase id/statedTotalMinor/vendorId, allocation existence, and the complete single-payment unique-match proof for every requested member. */
export function combinedChargeAllocations(input: {
  amountMinor: bigint;
  memberIds: readonly PurchaseId[];
  hasAllocation: boolean;
  purchases: readonly {
    id: PurchaseId;
    statedTotalMinor: bigint | null;
    namesThisCharge: boolean;
  }[];
}) {
  if (
    input.hasAllocation ||
    input.purchases.length !== new Set(input.memberIds).size ||
    input.purchases.some((row) => !row.namesThisCharge)
  )
    return null;
  if (
    input.purchases.reduce(
      (sum, row) => sum + (row.statedTotalMinor ?? 0n),
      0n,
    ) !== input.amountMinor
  )
    return null;
  return input.purchases.map((row) => ({
    purchaseId: row.id,
    amountMinor: row.statedTotalMinor ?? 0n,
  }));
}
