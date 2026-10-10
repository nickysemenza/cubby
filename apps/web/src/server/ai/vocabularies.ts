/** Classification rules used by the decision-tier suggestions. */
import type { ExternalIdKind } from "@cubby/schemas/external-id";

/** The location-type rules; the types themselves are the Jev choices. */

export const EXTERNAL_ID_KIND_DESCRIPTIONS = {
  asin: "Amazon's own catalog id: 'B0' followed by 8 letters/digits",
  retailer_sku:
    "A consumer retailer's own item number (Lowe's, Target, Walmart, Costco, Home Depot's non-barcode SKU, …)",
  internet_number:
    'Home Depot\'s 9-digit "internet number", distinct from its barcode',
  item_number:
    "The manufacturer's own model/part number, as printed on the product or its packaging",
  catalog_number:
    "A professional distributor's catalog/part number (McMaster-Carr, Grainger, DigiKey, …)",
  manufacturer_part:
    "A manufacturer's part number (MPN) that names ONE exact size/color variant; source is the manufacturer, not a seller. A shared family or style number is NOT this",
  gtin_14: "A barcode — UPC, EAN, or GTIN — 8 to 14 digits",
} satisfies Record<ExternalIdKind, string>;

export const EXTERNAL_ID_KIND_RULES = `You are a product external-identifier classification assistant. Given an identifier's source, its value, and (when known) the URL it came from and the product's name/manufacturer, determine which kind of identifier it is.

Rules:
1. An Amazon identifier starting "B0" followed by 8 alphanumeric characters is "asin".
2. 8, 12, 13 or 14 digits is normally a barcode ("gtin_14") — UNLESS the source is "home-depot" and it is exactly 9 digits, which is Home Depot's own "internet_number", not a barcode.
3. An identifier that reads as the product's own manufacturer model/part number (matches or closely resembles the given manufacturer) is "item_number".
4. A source that is a professional parts distributor (McMaster-Carr, Grainger, DigiKey, and similar) is "catalog_number".
5. A source that is a consumer retailer (Lowe's, Target, Walmart, Costco, and similar) is "retailer_sku".
6. A URL containing "/dp/" suggests Amazon ("asin"); "/p/" or "/pd/" suggest a retailer product page ("retailer_sku").`;

/**
 * One candidate tag at a time, judged against the product's own manufacturer,
 * classification path, category feature, and aliases (shown in the subject
 * above it). A `control.suggest.mode: "prune"` target proposes *removals*, so
 * this only ever answers "does this tag carry no information beyond what's
 * already on the record" — it never invents a replacement tag.
 */
