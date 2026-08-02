import { format } from "date-fns";
import { parsePlainDate } from "./plain-date";

/**
 * A purchase's human label.
 *
 * `Purchase` has no `name` column — its vendor identity is `(vendor, orderId,
 * date)` (see `packages/schemas/src/purchase.ts`), while `displayLabel` carries
 * optional human-entered context from the original ledger. ~40% of charges
 * never got an order id from the vendor at all. Every surface that renders one
 * (`EntityInlineLink`, the hover preview, an embedded charges table) therefore
 * needs the same fallback ladder, or the same charge reads differently in three
 * places.
 *
 * The ladder: the vendor's own order id when there is one (that's what a receipt
 * says and what the ledger's Order # links match on), otherwise vendor + charge
 * date, otherwise just the vendor. A nonblank display label is appended
 * parenthetically without replacing that identity.
 */
export function purchaseLabel(purchase: {
  orderId: string | null;
  displayLabel?: string | null;
  vendorName?: string | null;
  date?: string | null;
}): string {
  // `vendorName` is null only when the vendor row was soft-deleted, which the
  // repo refuses while live charges point at it — so this is a belt-and-braces
  // fallback, never the normal path.
  const vendor = purchase.vendorName ?? "Unknown vendor";
  const identity = purchase.orderId
    ? purchase.orderId
    : purchase.date
      ? `${vendor} · ${format(parsePlainDate(purchase.date), "MMM d, yyyy")}`
      : vendor;
  const displayLabel = purchase.displayLabel?.trim();
  return displayLabel ? `${identity} (${displayLabel})` : identity;
}

/**
 * Whether {@link purchaseLabel} already spent the vendor name on the label.
 * Callers that show the vendor as secondary metadata use this so it isn't
 * printed twice on an order-id-less charge.
 */
export const purchaseLabelUsedVendor = (purchase: {
  orderId: string | null;
}): boolean => !purchase.orderId;
