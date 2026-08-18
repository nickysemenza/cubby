import { z } from "zod";
import { imageOut } from "./image";
import { vendorRelatedFilterFields } from "./related-view";
import {
  auditDateFilterFields,
  deriveUpdateData,
  timestampedFields,
} from "./base-entity";
import { vendorShortcode } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";
import { plainDate } from "./project";
import { presenceFilter } from "./pagination";

/**
 * Vendor — the roster of places money goes. `Vendor ──< Purchase ──< Expense`:
 * a vendor issues purchases (`purchase`), each of which carries one or more
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
  orderUrlTemplate: z
    .string()
    .nullable()
    .describe(
      "URL pattern for this vendor's order-details page, with the literal token {orderId} standing in for a purchase's order id — e.g. \"https://www.amazon.com/gp/your-account/order-details?orderID={orderId}\". Null for vendors with no order lookup. The per-purchase link is derived from this at read time, never stored on the purchase.",
    ),
  notes: z.string().nullable(),
};

const vendorCreateShape = {
  ...vendorFields,
  website: z.string().nullable().default(null),
  orderUrlTemplate: z.string().nullable().default(null),
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
  ...auditDateFilterFields,
  ...vendorRelatedFilterFields,
  search: z.string().optional(),
  purchaseCountMin: z.coerce.number().int().nonnegative().optional(),
  purchaseCountMax: z.coerce.number().int().nonnegative().optional(),
  spendMin: z.coerce.number().optional(),
  spendMax: z.coerce.number().optional(),
  latestPurchaseDatePresenceFilter: presenceFilter,
  latestPurchaseDateFrom: plainDate.optional(),
  latestPurchaseDateTo: plainDate.optional(),
  logoPresenceFilter: presenceFilter,
};
export const vendorFiltersSchema = z.object(vendorFilterFields);
export type VendorFilters = z.infer<typeof vendorFiltersSchema>;

export const vendorSortableFields = [
  "name",
  // Rollups over the vendor's live purchases and their expenses, resolved by
  // correlated subqueries in repo/vendor.ts — not columns on `Vendor`.
  "purchaseCount",
  "spend",
  "latestPurchaseDate",
  "createdAt",
  "updatedAt",
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
  latestPurchaseDate: plainDate.nullable(),
  /** A displayable vendor brand mark, or null when the monogram is intentional. */
  logo: imageOut.nullable(),
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
 * `mergeVendors` in repo/vendor.ts for what happens to purchases the two vendors
 * hold under the same order id.
 */
export const mergeVendorsInput = z.object({
  keepId: vendorShortcode,
  mergeIds: z.array(vendorShortcode).min(1),
});
export type MergeVendorsInput = z.infer<typeof mergeVendorsInput>;

/** The token a `vendor.orderUrlTemplate` substitutes the order id into. */
const ORDER_ID_TOKEN = "{orderId}";

/**
 * True for the synthetic keys Cubby's importers mint when a vendor issued no
 * order number — `txn:2023-09-17/639/5201` for an in-store Home Depot receipt.
 * These are Cubby's own identifiers, not the vendor's, so no template can
 * resolve them: Home Depot's in-store lookup additionally wants a receipt
 * number, register number, and transaction type that were never captured.
 * Linking one would produce a dead link, which is worse than plain text.
 */
export const isSyntheticOrderId = (orderId: string): boolean =>
  orderId.startsWith("txn:");

/**
 * A purchase's link out to the vendor's own order page, derived from the
 * vendor's template rather than stored per purchase — the same shape as
 * `canonicalExternalIdUrl`, which derives an Amazon product link from its ASIN.
 *
 * Null whenever the link can't be trusted: no template, no order id, a
 * synthetic order id, a template missing the `{orderId}` token (a half-typed
 * value shouldn't silently link every purchase to the same page), or a result
 * that isn't an absolute http(s) URL.
 *
 * That last check is load-bearing in two directions, because `orderUrlTemplate`
 * is unvalidated free text a human pastes into the vendor page or writes over
 * MCP, while the derived `orderUrl` is `z.url()` inside `strictOutput`:
 *
 * - A scheme-less paste (`homedepot.com/orders?orderID={orderId}` — the natural
 *   thing to copy out of a browser) yields a string `z.url()` REJECTS, which
 *   would throw during output validation and 500 every `purchase.list` /
 *   `expense.list` / `problems.getFast` read containing that vendor, not merely
 *   drop the one link.
 * - `z.url()` ACCEPTS `javascript:alert(1)`, so validity alone is not enough:
 *   the result is rendered into an `href`, and a non-http(s) scheme there is a
 *   script-execution vector. Hence the explicit protocol allowlist rather than
 *   a bare `URL.canParse`.
 */
export const purchaseOrderUrl = (value: {
  orderUrlTemplate?: string | null;
  orderId?: string | null;
}): string | null => {
  const template = value.orderUrlTemplate?.trim();
  const orderId = value.orderId?.trim();
  if (!template || !orderId) return null;
  if (!template.includes(ORDER_ID_TOKEN)) return null;
  if (isSyntheticOrderId(orderId)) return null;

  const url = template.replaceAll(ORDER_ID_TOKEN, encodeURIComponent(orderId));
  if (!URL.canParse(url)) return null;
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:" ? url : null;
};
