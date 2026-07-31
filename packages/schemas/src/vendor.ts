import { z } from "zod";
import { deriveUpdateData, timestampedFields } from "./base-entity";
import { vendorShortcode } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";

/**
 * Vendor — the roster of places money goes. `Vendor ──< Purchase ──< Expense`:
 * a vendor issues charges (`purchase`), each of which carries one or more
 * categorized lines of spend (`expense`). All money lives on `expense`; a
 * vendor holds identity only.
 *
 * Deliberately thin in v1. Contractor metadata (license number, COI expiry) and
 * vendor-level documents (W-9, signed contracts) are the natural follow-ons once
 * the roster exists — they'd have had nowhere to live while `vendor` was a
 * free-text column repeated on every ledger row.
 */

const vendorFields = {
  name: z.string().min(1),
  website: z.string().nullable(),
  notes: z.string().nullable(),
};

const vendorCreateShape = {
  ...vendorFields,
  website: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
};

export const vendorCreateInput = z.object(vendorCreateShape);
export type VendorCreateInput = z.infer<typeof vendorCreateInput>;

export const vendorUpdateData = deriveUpdateData(vendorCreateShape);
export type VendorUpdateData = z.infer<typeof vendorUpdateData>;
export const vendorUpdateInput = z.object({
  id: vendorShortcode,
  data: vendorUpdateData,
});
export type VendorUpdateInput = z.infer<typeof vendorUpdateInput>;

export const vendorFilterFields = {
  search: z.string().optional(),
};
export const vendorFiltersSchema = z.object(vendorFilterFields);
export type VendorFilters = z.infer<typeof vendorFiltersSchema>;

export const vendorSortableFields = [
  "name",
  // Rollups over the vendor's live purchases and their expenses, resolved by
  // correlated subqueries in repo/vendor.ts — not columns on `Vendor`.
  "purchaseCount",
  "spend",
  "createdAt",
] as const;
export type VendorSortField = (typeof vendorSortableFields)[number];

export const vendorOut = z.object({
  id: vendorShortcode,
  ...vendorFields,
  /** Live purchases pointing at this vendor. Gates deletion. */
  purchaseCount: z.number().int(),
  /**
   * `SUM(cost)` over the live expenses of this vendor's live purchases — the
   * blended net, same convention as `projectRollups.spent`. Never derived from
   * `purchase.statedTotal`, which is not spend.
   */
  spend: z.number(),
  ...timestampedFields,
});
export type VendorOut = z.infer<typeof vendorOut>;

export const vendorListResponse = createPaginatedResponseSchema(vendorOut);
export type VendorListResponse = z.infer<typeof vendorListResponse>;

/**
 * The vendor picklist behind the ledger's Vendor filter and the purchase form's
 * combobox. `{id, name, count}` rather than the old `{vendor, count}`: the
 * filter now matches vendor **ids**, so the option has to carry one.
 */
export const vendorOptionsOut = z.array(
  z.object({
    id: vendorShortcode,
    name: z.string(),
    count: z.number().int(),
  }),
);
export type VendorOptionsOut = z.infer<typeof vendorOptionsOut>;

/**
 * Fold duplicate vendors into one — the fix for the duplicate-vendor worklist.
 *
 * `findOrCreateVendor` matches names exactly, so an importer meeting a new
 * spelling mints a new roster row; nothing on the write path can safely decide
 * two spellings are the same vendor. This is how a human says so. See
 * `mergeVendors` in repo/vendor.ts for what happens to charges the two vendors
 * hold under the same order id.
 */
export const mergeVendorsInput = z.object({
  keepId: vendorShortcode,
  mergeIds: z.array(vendorShortcode).min(1),
});
export type MergeVendorsInput = z.infer<typeof mergeVendorsInput>;
