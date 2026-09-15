import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { imageUrlSummary } from "./image-summary";
import { vendorRelatedFilterFields } from "./related-view";
import { auditDateFilterFields } from "./base-entity";
import {
  generatedVendorFieldSchemas,
  generatedVendorFilterFields,
} from "./generated/entity-field-schemas.vendor.gen";
import { vendorShortcode } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";
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

const vendorCreateFields = generatedVendorFieldSchemas.create;

export const vendorCreateInput = z.object(vendorCreateFields);
export type VendorCreateInput = z.infer<typeof vendorCreateInput>;

export const vendorUpdateData = z.object(generatedVendorFieldSchemas.update);
export type VendorUpdateData = z.infer<typeof vendorUpdateData>;
export const vendorUpdateInput = z.object({
  id: vendorShortcode,
  data: vendorUpdateData,
});
export type VendorUpdateInput = z.infer<typeof vendorUpdateInput>;

export const fetchVendorLogoInput = z.object({ id: vendorShortcode });
export type FetchVendorLogoInput = z.infer<typeof fetchVendorLogoInput>;

export const vendorFilterFields = {
  ...auditDateFilterFields,
  ...vendorRelatedFilterFields,
  ...generatedVendorFilterFields,
  latestPurchaseDatePresenceFilter: presenceFilter,
  logoPresenceFilter: presenceFilter,
};
export const vendorFiltersSchema = z.object(vendorFilterFields);
export type VendorFilters = z.infer<typeof vendorFiltersSchema>;

// `purchaseCount`, `spend`, and `latestPurchaseDate` are rollups over the
// vendor's live purchases and their expenses, resolved by correlated
// subqueries in repo/vendor.ts — not columns on `Vendor`.
export type VendorSortField = GeneratedEntitySortField<"vendor">;

export const vendorOut = z.object({
  ...generatedVendorFieldSchemas.read,
});
export type VendorOut = z.infer<typeof vendorOut>;

export const vendorListResponse = createPaginatedResponseSchema(vendorOut);
export type VendorListResponse = z.infer<typeof vendorListResponse>;

export const vendorCoverageInput = z
  .object({
    vendorId: vendorShortcode,
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine((value) => value.from <= value.to, {
    message: "from must be on or before to",
    path: ["to"],
  });
export const vendorCoverageOut = z.object({
  vendor: z.object({ id: vendorShortcode, name: z.string() }),
  latestPurchaseDate: z.iso.date().nullable(),
  from: z.iso.date(),
  to: z.iso.date(),
  orderIds: z.array(z.string()),
});

export const vendorOptionsOut = z.array(
  z.object({
    id: vendorShortcode,
    name: z.string(),
    count: z.number().int(),
    logo: imageUrlSummary.nullable(),
  }),
);
export type VendorOptionsOut = z.infer<typeof vendorOptionsOut>;

export const mergeVendorsInput = z.object({
  keepId: vendorShortcode,
  mergeIds: z.array(vendorShortcode).min(1),
});
export type MergeVendorsInput = z.infer<typeof mergeVendorsInput>;

/**
 * What a vendor merge actually moved or carried — populated straight from the
 * merge's own `VendorMergePlan` (`repo/vendor.ts`'s `planVendorMerge`), never
 * computed fresh for reporting. Mirrors the `{ product, mergeSummary }` shape
 * `mergeProductsOut` uses.
 */
export const vendorMergeSummaryOut = z.object({
  keepId: vendorShortcode,
  /** Merged-away vendor rows, now soft-deleted tombstones. */
  deletedIds: z.array(vendorShortcode),
  /**
   * Vendor rows the merge actually soft-deleted, read back from the write
   * itself (`finalizeMerge`) rather than assumed from `mergeIds.length`.
   */
  merged: z.number().int().nonnegative(),
  purchasesRepointed: z.number().int().nonnegative(),
  /**
   * Purchases folded into a same-order survivor instead of re-pointed — their
   * expenses and documents moved with them, and the loser purchase was
   * soft-deleted. Reported as a count, not per-purchase: the plan tracks
   * folded pairs by internal purchase id, and turning those into the
   * `PUR-` shortcodes a caller could act on would need a lookup the plan
   * doesn't already carry (see `previewMergeVendors`'s own transitive counts
   * for a finer breakdown, computed separately for that read-only preview).
   */
  purchasesFolded: z.number().int().nonnegative(),
  carriedFields: z.array(z.string()),
});
export type VendorMergeSummaryOut = z.infer<typeof vendorMergeSummaryOut>;

export const mergeVendorsOut = z.object({
  vendor: vendorOut,
  mergeSummary: vendorMergeSummaryOut,
});
export type MergeVendorsOut = z.infer<typeof mergeVendorsOut>;

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
