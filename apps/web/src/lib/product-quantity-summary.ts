import type {
  ProductQuantityLedgerOut,
  ProductQuantitySummaryOut,
} from "@cubby/schemas/product";

/** A recorded zero needs known movements; missing quantities keep the balance provisional. */
export const hasComparableQuantityHistory = (
  ledger: ProductQuantityLedgerOut,
) =>
  ledger.unknownAcquisitionLines === 0 &&
  ledger.unknownExitLines === 0 &&
  (ledger.acquiredUnits > 0 || ledger.exitedUnits > 0);

/** Acquisition units and installed Locations are counts, so weight/volume cannot be summed with them. */
export function deriveProductQuantitySummary(
  entries: readonly { amount: { value: number; unit: string } }[],
  quantityLedger: ProductQuantityLedgerOut,
): Pick<
  ProductQuantitySummaryOut,
  "quantityLedger" | "onHandUnits" | "quantityVariance"
> {
  const countable = entries.every((entry) => entry.amount.unit === "each");
  const onHandUnits =
    countable && (entries.length > 0 || quantityLedger.locationCount > 0)
      ? entries.reduce(
          (sum, entry) => sum + entry.amount.value,
          quantityLedger.locationCount,
        )
      : null;
  return {
    quantityLedger,
    onHandUnits,
    quantityVariance:
      onHandUnits !== null && hasComparableQuantityHistory(quantityLedger)
        ? onHandUnits - quantityLedger.expectedQuantity
        : null,
  };
}
