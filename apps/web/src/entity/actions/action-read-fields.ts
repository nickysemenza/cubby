/** The discard dialog needs current shelf choices even when the Stock column is hidden. */
export const PRODUCT_DISCARD_READ_FIELDS = ["name", "inventoryEntry"] as const;

/** Eligibility is cheap; the editor owns the fresh complete settlement baseline. */
export const EXPENSE_MARK_PURCHASED_READ_FIELDS = [
  "lineKind",
  "future",
] as const;

/** Inventory dialogs need the canonical quantity, shelf and product identity. */
export const INVENTORY_DIALOG_READ_FIELDS = [
  "product",
  "location",
  "amount",
  "locationId",
] as const;

export const EXPENSE_RECEIVE_READ_FIELDS = [
  "name",
  "productId",
  "productName",
] as const;
