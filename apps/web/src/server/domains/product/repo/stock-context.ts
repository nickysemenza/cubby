import type { DisplayItem } from "@cubby/schemas/entity-definitions/label-field";
import type { ProductListItem } from "@cubby/schemas/product";

import {
  deriveProductQuantitySummary,
  hasComparableQuantityHistory,
} from "~/server/lib/product-quantity-summary";

type StockContextInput = Pick<ProductListItem, "quantityLedger"> & {
  inventoryEntry: readonly Pick<
    ProductListItem["inventoryEntry"][number],
    "amount"
  >[];
  stockTracked?: boolean | null;
};

/** Recorded quantities describe evidence, never automatic consumption or disposal. */
export function productStockContext({
  quantityLedger: ledger,
  inventoryEntry,
  stockTracked,
}: StockContextInput) {
  const details: DisplayItem[] = [];
  const fact = (title: string, subtitle: string | null = null) =>
    details.push({ entity: null, id: null, title, subtitle, trailing: null });
  const incomplete =
    ledger.unknownAcquisitionLines + ledger.unknownExitLines > 0;
  const hasKnownHistory = ledger.acquiredUnits > 0 || ledger.exitedUnits > 0;
  const quantity = deriveProductQuantitySummary(inventoryEntry, ledger);
  const comparable =
    quantity.onHandUnits !== null ||
    (inventoryEntry.length === 0 && ledger.locationCount === 0);
  const located = comparable ? (quantity.onHandUnits ?? 0) : null;
  const difference =
    located === null || !hasComparableQuantityHistory(ledger)
      ? null
      : Math.round((ledger.expectedQuantity - located) * 1e6) / 1e6;
  const policy =
    stockTracked === false
      ? "Stock not tracked"
      : stockTracked === true
        ? "Stock tracked"
        : "Tracking policy undecided";
  fact(policy, "Tracking policy does not remove manually recorded inventory.");
  fact(
    `${inventoryEntry.length} inventory ${inventoryEntry.length === 1 ? "entry" : "entries"} recorded`,
  );
  if (ledger.locationCount > 0)
    fact(
      "Serves as a location",
      `${ledger.locationCount} installed ${ledger.locationCount === 1 ? "location" : "locations"}; included in located units.`,
    );
  fact(
    `${ledger.acquiredUnits} acquired · ${ledger.exitedUnits} exited`,
    "Known quantities from records; consumption is not inferred.",
  );
  if (incomplete)
    fact(
      "Quantity history incomplete",
      `${ledger.unknownAcquisitionLines} acquisition lines and ${ledger.unknownExitLines} exit lines have unknown quantities, including kit history.`,
    );
  else if (!hasKnownHistory)
    fact(
      "No quantified acquisition or exit history",
      "A zero balance alone does not establish that nothing is owned.",
    );
  else fact(`Recorded balance: ${ledger.expectedQuantity}`);
  if (!comparable)
    fact(
      "Inventory quantity not comparable",
      "Inventory must be recorded in each units to compare it with the acquisition ledger.",
    );
  let stockStatus: string;
  if (
    inventoryEntry.length === 0 &&
    ledger.locationCount === 0 &&
    stockTracked === false
  )
    stockStatus = "Stock not tracked";
  else if (ledger.expectedQuantity < 0)
    stockStatus = "Recorded exits exceed acquisitions";
  else if (difference !== null && difference > 0)
    stockStatus = `${difference} expected ${difference === 1 ? "item" : "items"} unlocated`;
  else if (difference !== null && difference < 0)
    stockStatus = `${-difference} more located than recorded balance`;
  else if (inventoryEntry.length > 0)
    stockStatus = incomplete
      ? "Quantity history incomplete"
      : !comparable
        ? "Inventory quantity not comparable"
        : hasKnownHistory
          ? "Located quantity matches records"
          : "Inventory recorded; quantity history unknown";
  else if (ledger.locationCount > 0) stockStatus = "Serves as a location";
  else if (stockTracked === false) stockStatus = "Stock not tracked";
  else if (incomplete) stockStatus = "Quantity history incomplete";
  else if (hasKnownHistory)
    stockStatus = `Recorded balance: ${ledger.expectedQuantity}`;
  else stockStatus = "No inventory recorded";
  if (difference !== null && difference !== 0)
    fact(
      stockStatus,
      "Based on recorded quantities; review inventory and movement history.",
    );
  return { stockStatus, stockStatusItems: details };
}
