import { z } from "zod";
import { deriveUpdateData, timestampedFields } from "./base-entity";
import { vendorId } from "./identifiers";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";

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

/**
 * What kind of counterparty this is. Follows `tradeValues` (project.ts): a flat
 * slug enum with human labels beside it, no hierarchy. Nullable on the row —
 * the backfill can't infer it, and guessing would be worse than blank.
 */
export const vendorKindValues = [
  "retailer",
  "contractor",
  "supplier",
  "other",
] as const;
export const vendorKindSchema = z.enum(vendorKindValues);
export type VendorKind = z.infer<typeof vendorKindSchema>;

export const VENDOR_KIND_LABELS: Record<VendorKind, string> = {
  retailer: "Retailer",
  contractor: "Contractor",
  supplier: "Supplier",
  other: "Other",
};

const vendorFields = {
  name: z.string().min(1),
  kind: vendorKindSchema.nullable(),
  website: z.string().nullable(),
  notes: z.string().nullable(),
};

const vendorCreateShape = {
  ...vendorFields,
  kind: vendorKindSchema.nullable().default(null),
  website: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
};

export const vendorCreateInput = z.object(vendorCreateShape);
export type VendorCreateInput = z.infer<typeof vendorCreateInput>;

export const vendorUpdateData = deriveUpdateData(vendorCreateShape);
export type VendorUpdateData = z.infer<typeof vendorUpdateData>;
export const vendorUpdateInput = z.object({
  id: vendorId,
  data: vendorUpdateData,
});
export type VendorUpdateInput = z.infer<typeof vendorUpdateInput>;

export const vendorFilterFields = {
  search: z.string().optional(),
  kind: oneOrMany(vendorKindSchema).optional(),
  /**
   * `"none"` matches vendors with no `kind` set — the classify-the-roster
   * worklist, and the reason `kind` is nullable at all (the backfill can't infer
   * it). ORs with `kind` rather than ANDing, per `eqAnyOrPresence`, so
   * "contractors or unclassified" is one filter.
   *
   * A separate field rather than a `__none__` sentinel inside `kind`: that value
   * would fall through into the enum list and be rejected by `vendorKindSchema`
   * at the tRPC boundary. Same shape as every other `*PresenceFilter`.
   */
  kindPresenceFilter: presenceFilter,
};
export const vendorFiltersSchema = z.object(vendorFilterFields);
export type VendorFilters = z.infer<typeof vendorFiltersSchema>;

export const vendorSortableFields = [
  "name",
  "kind",
  // Rollups over the vendor's live purchases and their expenses, resolved by
  // correlated subqueries in repo/vendor.ts — not columns on `Vendor`.
  "purchaseCount",
  "spend",
  "createdAt",
] as const;
export type VendorSortField = (typeof vendorSortableFields)[number];

export const vendorOut = z.object({
  id: vendorId,
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
    id: vendorId,
    name: z.string(),
    count: z.number().int(),
  }),
);
export type VendorOptionsOut = z.infer<typeof vendorOptionsOut>;
