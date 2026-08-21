import { z } from "zod";

export const externalIdSource = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "source must be a lowercase kebab-case slug",
  );

export const externalIdKind = z.enum([
  "asin",
  "retailer_sku",
  "internet_number",
  "item_number",
  "catalog_number",
  // Barcodes, by digit length. They live here rather than in a scalar column
  // because a product routinely carries more than one — a manufacturer
  // reissues a SKU, a retailer relabels, two listings of one item disagree —
  // and `Product.upc` could hold exactly one, so every merge of two barcoded
  // products destroyed a real identifier.
  "upc_a",
  "ean_13",
  "ean_8",
  "gtin_14",
  "legacy_unspecified",
]);
export type ExternalIdKind = z.infer<typeof externalIdKind>;

/** The slug barcodes are recorded under, regardless of which encoding. */
export const GTIN_SOURCE = "gtin";

const GTIN_KIND_BY_LENGTH: Record<number, ExternalIdKind> = {
  8: "ean_8",
  12: "upc_a",
  13: "ean_13",
  14: "gtin_14",
};

/**
 * Which barcode kind a digit string is, by length.
 *
 * Returns null for anything that is not a recognized GTIN length — the caller
 * decides whether that is a rejection or a `legacy_unspecified` row, because
 * the backfill has to keep values the current input schema would refuse.
 */
export const gtinKindForValue = (value: string): ExternalIdKind | null =>
  /^\d+$/.test(value) ? (GTIN_KIND_BY_LENGTH[value.length] ?? null) : null;

/** True for the kinds recorded under `GTIN_SOURCE`. */
export const isGtinKind = (kind: ExternalIdKind): boolean =>
  kind === "upc_a" ||
  kind === "ean_13" ||
  kind === "ean_8" ||
  kind === "gtin_14";

export const canonicalExternalIdUrl = (value: {
  source: string;
  kind: ExternalIdKind;
  externalId: string;
  url?: string | null;
}): string | null =>
  value.source === "amazon" && value.kind === "asin"
    ? `https://www.amazon.com/dp/${encodeURIComponent(value.externalId)}`
    : (value.url ?? null);

/** Canonical Amazon links are derived from ASIN rather than stored twice. */
export const storedExternalIdUrl = (value: {
  source: string;
  kind: ExternalIdKind;
  url?: string | null;
}): string | null =>
  value.source === "amazon" && value.kind === "asin"
    ? null
    : (value.url ?? null);

const externalIdValueFields = {
  source: externalIdSource.describe(
    "Canonical provider slug (e.g. 'amazon', 'home-depot', 'mcmaster')",
  ),
  kind: externalIdKind,
  externalId: z
    .string()
    .min(1)
    .describe("The actual identifier (ASIN, part number, etc.)"),
  url: z
    .string()
    .url()
    .nullish()
    .describe("Optional direct link to the product page"),
  /**
   * The value to show when one has to stand for the slot — the barcode on the
   * package, the ASIN of the listing actually bought from.
   *
   * One primary per (product, source, kind), enforced by a partial unique;
   * secondaries are unlimited. Omitted means primary, so a caller that knows
   * nothing about this keeps working.
   *
   * `.optional()` rather than `.default(true)`: a zod default makes the parsed
   * output type wider than the input, and react-hook-form's resolver requires
   * the two to agree. The default lives on the column and in the repo layer.
   */
  isPrimary: z.boolean().optional(),
};

export const externalIdValueInput = z.object(externalIdValueFields);

export const externalIdInput = z.object({
  ...externalIdValueFields,
  id: z.uuid().optional(),
});

export type ExternalIdInput = z.infer<typeof externalIdInput>;

/**
 * A slot may hold many identifiers but only one primary.
 *
 * This used to reject any repeated `(source, kind)`, which is what made
 * `Product.upc` the only place a second barcode could go — and it had room for
 * one. Now it mirrors the partial unique in the database exactly.
 */
const uniqueExternalIdSlots = <T extends z.ZodType>(item: T) =>
  z.array(item).superRefine((values, ctx) => {
    const primaries = new Set<string>();
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const entry = value as {
        source: string;
        kind: ExternalIdKind;
        externalId: string;
        isPrimary?: boolean;
      };
      const slot = `${entry.source}\u0000${entry.kind}`;
      // The same value twice in one slot is a duplicate however it is flagged;
      // the database's global unique would reject it anyway, less legibly.
      const value_ = `${slot}\u0000${entry.externalId}`;
      if (seen.has(value_)) {
        ctx.addIssue({
          code: "custom",
          message: "the same identifier is listed twice for this source/kind",
          path: [index, "externalId"],
        });
      }
      seen.add(value_);
      if (entry.isPrimary === false) continue;
      if (primaries.has(slot)) {
        ctx.addIssue({
          code: "custom",
          message:
            "each Product may have only one PRIMARY identifier per source/kind; mark the others isPrimary: false",
          path: [index, "isPrimary"],
        });
      }
      primaries.add(slot);
    }
    // These payloads REPLACE the identifier set, so a slot whose every entry is
    // a secondary leaves it with no primary. The partial unique only forbids
    // two, so nothing downstream would reject it — the slot would just stop
    // answering, since the next primary upsert's arbiter matches no row.
    for (const [index, value] of values.entries()) {
      const entry = value as { source: string; kind: ExternalIdKind };
      const slot = `${entry.source}\u0000${entry.kind}`;
      if (primaries.has(slot)) continue;
      ctx.addIssue({
        code: "custom",
        message:
          "each source/kind slot needs one PRIMARY identifier; at least one entry must omit isPrimary or set it true",
        path: [index, "isPrimary"],
      });
    }
  });

export const externalIdInputs = uniqueExternalIdSlots(externalIdInput);
export const externalIdValues = uniqueExternalIdSlots(externalIdValueInput);

export const externalIdOut = z.object({
  id: z.uuid(),
  source: externalIdSource.describe(
    "Canonical provider slug (e.g. 'amazon', 'home-depot', 'mcmaster')",
  ),
  kind: externalIdKind,
  externalId: z
    .string()
    .min(1)
    .describe("The actual identifier (ASIN, part number, etc.)"),
  url: z
    .string()
    .url()
    .nullish()
    .describe("Optional direct link to the product page"),
  /** One per (source, kind); see `externalIdValueFields.isPrimary`. */
  isPrimary: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ExternalIdOut = z.infer<typeof externalIdOut>;
