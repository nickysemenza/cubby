import { z } from "zod";

export const externalIdSource = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "source must be a lowercase kebab-case slug",
  )
  .meta({ mockValue: "example-vendor" });

export const externalIdKind = z.enum([
  "asin",
  "retailer_sku",
  "internet_number",
  "item_number",
  "catalog_number",
  // Barcodes. They live here rather than in a scalar column because a product
  // routinely carries more than one — a manufacturer reissues a SKU, a retailer
  // relabels, two listings of one item disagree — and `Product.upc` could hold
  // exactly one, so every merge of two barcoded products destroyed a real
  // identifier.
  //
  // ONE kind, not one per encoding: a 12-digit UPC-A and its 13-digit EAN-13
  // reprint are the same barcode, and storing them under different kinds put
  // them in different slots, where neither the unique index nor duplicate
  // detection could see they were the same. Values are normalized to GTIN-14 on
  // the write boundary (`gtin` below), so the encoding is a presentation
  // concern (`displayGtin`) rather than an identity one.
  "gtin_14",
  "legacy_unspecified",
]);
export type ExternalIdKind = z.infer<typeof externalIdKind>;

export const GTIN_SOURCE = "gtin";

export const GTIN_KIND = "gtin_14" satisfies ExternalIdKind;

export const isGtinKind = (kind: ExternalIdKind): boolean => kind === GTIN_KIND;

/**
 * The canonical GTIN-14 form — the identity every encoding of one barcode
 * shares.
 *
 * Returns null for anything that is not 8-14 digits. That guard is
 * load-bearing on the SQL side: Postgres `lpad(x, 14, '0')` TRUNCATES longer
 * input rather than erroring, so a silently-truncated value would collide with
 * a real barcode under the global `(source, kind, externalId)` unique.
 */
export const normalizeGtin = (value: string): string | null =>
  /^\d{8,14}$/.test(value) ? value.padStart(14, "0") : null;

export const displayGtin = (value: string): string =>
  value.replace(/^0+/, "").padStart(12, "0");

/**
 * A barcode on the WRITE boundary: any encoding in, canonical GTIN-14 out, so
 * a 12-digit UPC-A and its 13-digit reprint cannot become two rows.
 *
 * `.transform()` rather than `.default()`: a zod default makes the parsed
 * output type wider than the input and react-hook-form's resolver requires the
 * two to agree (see `externalIdValueFields.isPrimary`). A transform from string
 * to string leaves them identical, so the form resolver is unaffected.
 *
 * Distinct from `upc` in `@cubby/shared/upc`, which is the barcode being
 * LOOKED UP against USDA and the UPC provider — those index their own
 * encodings and must not be normalized.
 */
export const gtin = z
  .string()
  .trim()
  .regex(/^\d{8,14}$/, "a barcode is 8-14 digits")
  .transform((value) => value.padStart(14, "0"))
  .pipe(z.string().regex(/^\d{14}$/))
  .describe("Barcode (UPC/EAN/GTIN); stored canonically as GTIN-14");

export const canonicalExternalIdUrl = (value: {
  source: string;
  kind: ExternalIdKind;
  externalId: string;
  url?: string | null;
}): string | null =>
  value.source === "amazon" && value.kind === "asin"
    ? `https://www.amazon.com/dp/${encodeURIComponent(value.externalId)}`
    : (value.url ?? null);

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
type ExternalIdSlot = {
  source: string;
  kind: ExternalIdKind;
  externalId: string;
  isPrimary?: boolean;
};

const uniqueExternalIdSlots = <T extends z.ZodType<ExternalIdSlot>>(item: T) =>
  z.array(item).superRefine((values, ctx) => {
    const primaries = new Set<string>();
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const entry = value;
      const slot = `${entry.source}\u0000${entry.kind}`;
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
      const entry = value;
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
  isPrimary: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ExternalIdOut = z.infer<typeof externalIdOut>;

/**
 * Every identifier kind the generic `EntityExternalId` table accepts, and the
 * entity kinds each may attach to. The generator emits the table's
 * `(entityKind, kind)` CHECK from this map. `externalIdKind` above stays the
 * Product-facing subset that product editors and AI suggestions offer.
 *
 * `primarySlot`: whether one identifier per `(entity, source, kind)` is the
 * primary. Settlement references are plain references — one card charge can
 * carry several order ids — so they have no primary.
 *
 * Every kind is globally unique among live rows on `(source, kind,
 * externalId)`: an identifier names at most one live entity.
 */
export const EXTERNAL_ID_KINDS = {
  asin: { entities: ["product"], primarySlot: true },
  retailer_sku: { entities: ["product"], primarySlot: true },
  internet_number: { entities: ["product"], primarySlot: true },
  item_number: { entities: ["product"], primarySlot: true },
  catalog_number: { entities: ["product"], primarySlot: true },
  gtin_14: { entities: ["product"], primarySlot: true },
  legacy_unspecified: { entities: ["product"], primarySlot: true },
  settlement_ref: { entities: ["financialTransaction"], primarySlot: false },
  page: {
    entities: ["expense", "task", "project", "recipe"],
    primarySlot: true,
  },
  folder: { entities: ["project"], primarySlot: true },
} as const satisfies Record<
  string,
  { entities: readonly string[]; primarySlot: boolean }
>;

export type EntityExternalIdKind = keyof typeof EXTERNAL_ID_KINDS;

export const entityExternalIdKind = z.enum(
  // SAFETY: Object.keys of a non-empty const literal returns exactly its declared keys.
  Object.keys(EXTERNAL_ID_KINDS) as [
    EntityExternalIdKind,
    ...EntityExternalIdKind[],
  ],
);

/** Sources that are not vendors but still name where an identifier came from. */
export const NOTION_SOURCE = "notion";
export const GOOGLE_DRIVE_SOURCE = "google-drive";
