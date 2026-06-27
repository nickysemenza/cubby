import type { EnrichmentRow } from "@cubby/schemas/ingredient";
import { hasPriceEntry } from "./workbench-editor-core";

const FIX_LABEL: Record<EnrichmentRow["recommendedFix"], string> = {
  "no-product": "Link product",
  "link-usda": "Link USDA",
  "set-per-item-price": "Set price",
  "add-purchase-mapping": "Set price",
  "add-weight-mapping": "Add weight",
  "add-volume-mapping": "Add volume",
  done: "Done",
};

// The "Next" badge label. A priced-but-money-uncovered row is islanded — the fix
// is to connect the existing price, not set a new one, so say so.
export const fixBadgeLabel = (row: EnrichmentRow): string => {
  if (
    !row.coverage.covered.includes("money") &&
    hasPriceEntry(row) &&
    (row.recommendedFix === "set-per-item-price" ||
      row.recommendedFix === "add-purchase-mapping" ||
      row.recommendedFix === "add-weight-mapping")
  ) {
    return "Connect price";
  }
  return FIX_LABEL[row.recommendedFix];
};
