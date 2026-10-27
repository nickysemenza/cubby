import { z } from "zod";
import { foodSummary } from "@cubby/usda";
import { inventoryPlacementValues } from "@cubby/shared";
import { resolvedListSchema } from "./field-resolution";
import { displayItems, listLabel } from "./entity-definitions/label-field";
import { displayImagesField } from "./display-images";
import { timestampedFields, plainDate } from "./base-entity";
import {
  cookbookShortcode,
  ingredientShortcode,
  inventoryShortcode,
} from "./identifier-fields";
import { locationListRefOut } from "./location-fields";
import { imageUrlSummary } from "./image-summary";
import { amount } from "./codec";
import { money, moneyNullable } from "./money";
import { ingredientApplicabilityKey } from "./codec";
import { recipeUsageOut } from "./recipe-fields";
import { unitMappingOut, unitMappingWithMetadata } from "./unitmapping";
const locationAncestorFields = locationListRefOut.shape;
const locationPathRefFields = locationListRefOut.shape;
export const productQuantityLedgerOut = z.object({
  acquiredUnits: z.number().nonnegative(),
  exitedUnits: z.number().nonnegative(),
  expectedQuantity: z.number(),
  /**
   * Lines that carry no quantity, so they contribute nothing to the totals
   * above. Reported rather than guessed at: a receipt that proves the cost but
   * not the count must not silently read as one unit.
   */
  unknownAcquisitionLines: z.number().int().nonnegative(),
  unknownExitLines: z.number().int().nonnegative(),
  /**
   * Locations that ARE an instance of this product — a bin, tote or rack in
   * service rather than stock on a shelf.
   *
   * Units in use as locations are still units you own, so on-hand counts add
   * this to the inventory sum. Without it every container promoted to a
   * Location would read as missing and light "Shelf disagrees" forever — the
   * same false-variance trap `includes-installed` documents for fixtures.
   */
  locationCount: z.number().int().nonnegative(),
});
export type ProductQuantityLedgerOut = z.infer<typeof productQuantityLedgerOut>;

export const productIngredientOut = z.object({
  id: ingredientShortcode,
  name: z.string().meta({ mock: "food.ingredient" }),
  aliases: z.array(z.string()),
  naKinds: z.array(ingredientApplicabilityKey),
  ...timestampedFields,
});

const productInventoryFields = {
  id: inventoryShortcode,
  amount,
  valuation: moneyNullable,
  // Last deliberate recount (null = never). `updatedAt` moves on any write —
  // including a price-driven valuation recompute — so it can't stand in for
  // "when was this count last confirmed".
  verifiedAt: z.date().nullable(),
  // Included on purpose: "where does this product live" is an ownership
  // question, so the dimmer wired into the kitchen wall belongs in this list.
  // Carrying placement is what lets the row say "installed" instead of
  // reporting a verification age a fixture can never have.
  placement: z.enum(inventoryPlacementValues),
  ...timestampedFields,
};

const productLocationAncestorOut = z.object({
  ...locationAncestorFields,
  displayImage: imageUrlSummary.nullable(),
});

export const productCookbookRefOut = z.object({
  id: cookbookShortcode,
  name: z.string(),
});
export type ProductCookbookRefOut = z.infer<typeof productCookbookRefOut>;

export const productLocationRefOut = z.object({
  ...locationPathRefFields,
  displayImage: imageUrlSummary.nullable(),
  ancestors: z.array(productLocationAncestorOut),
});

/** A bounded live Inventory row; its holding Location is identity only. */
export const rawProductInventoryWithLocationOut = z.object({
  ...productInventoryFields,
  location: locationListRefOut.pick({ id: true, name: true }),
});

export const productPrimaryPlacement = z.object({
  locationId: z.string(),
  path: z.string(),
  onHand: z.number(),
});

export type ProductPrimaryPlacement = z.infer<typeof productPrimaryPlacement>;

export const productQuantityFields = {
  primaryPlacement: productPrimaryPlacement.nullable(),
  stockStatus: z.string().nullish(),
  stockStatusItems: displayItems,
  quantityLedger: productQuantityLedgerOut,
  onHandUnits: z.number().nullable(),
  quantityVariance: z.number().nullable(),
};

export type RawProductListInventoryEntryOut = z.output<
  typeof rawProductInventoryWithLocationOut
>;

export const productUnitPriceMappings = z
  .array(unitMappingWithMetadata)
  .default([]);

export const productOwnershipEvidenceOut = z.object({
  state: z.enum(["owned", "exited", "uncertain"]),
  acquiredAt: plainDate.nullable(),
  exitedAt: plainDate.nullable(),
  confidenceLostAt: plainDate.nullable(),
});
export type ProductOwnershipEvidenceOut = z.infer<
  typeof productOwnershipEvidenceOut
>;

/**
 * Which nutrition a Product shows and how to caption it, chosen once on the
 * server (package label > linked USDA food > none) so web and native render
 * the same source, basis, and rows. `title` is the heading ("From package
 * label", "From USDA") or, for `none`, the empty-state message.
 */
export const productNutritionDisplay = z.object({
  source: z.enum(["label", "usda", "none"]),
  title: z.string(),
  /** "Per serving · 44 g" or "Per 100 g"; empty for `none`. */
  basis: z.string(),
  /** The label's provenance note (e.g. a package name). */
  sourceNote: z.string().nullable(),
  /** Label evidence for any inferred-zero rows; null when there are none. */
  inferenceEvidence: z.string().nullable(),
  /**
   * Numbers, not strings, so each client formats with its own locale;
   * `inferred` marks a zero the label implies rather than states.
   */
  rows: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      amount: z.number(),
      inferred: z.boolean(),
    }),
  ),
});
export type ProductNutritionDisplay = z.infer<typeof productNutritionDisplay>;

export function productReadSchemas<
  S extends z.ZodRawShape,
  C extends z.ZodType<string>,
>(base: z.ZodObject<S>, facts: { ownDataCheck: C }) {
  const output = base.extend({ coverImageUrl: z.url().nullable() });
  const list = base.extend({
    displayImages: displayImagesField,
    unitMappings: z.array(unitMappingOut),
    unitPriceMappings: productUnitPriceMappings,
    unitPrice: z
      .object({
        natural: z.object({ price: z.number(), unit: z.string() }).nullable(),
        perGram: z.number().nullable(),
      })
      .nullable()
      .default(null),
    food: foodSummary.nullable().default(null),
    modelPresence: z.boolean(),
    upcPresence: z.boolean(),
    notesPresence: z.boolean(),
    dataGaps: z.array(facts.ownDataCheck),
    ingredient: productIngredientOut.nullable(),
    inventoryEntry: z.array(rawProductInventoryWithLocationOut),
    expenseCount: z.number().int(),
    // Live `productComponent` links where this product is the parent — non-zero
    // means it's a kit or multi-pack. Counts distinct components, not units: a
    // 4-pack stored as one edge with `quantity: 4` reads as 1.
    componentCount: z.number().int().nonnegative(),
    // Net basis: SUM(expense.cost) over this product's live expenses. Plain sum
    // IS the net basis here — negative rows (refunds, disposals) are real in
    // this ledger, so they telescope correctly. 0 for a product with no
    // expenses, never null.
    expenseTotal: money,
    purchaseDate: plainDate.nullable(),
    /** Published owner collection; null until a result is available. */
    owners: resolvedListSchema.nullable(),
    ...productQuantityFields,
    // Server-composed text for the Expected, Variance and Unit price columns.
    ledgerExpectedQuantityLabel: listLabel,
    quantityVarianceLabel: listLabel,
    unitPriceLabel: listLabel,
  });
  const detail = base.extend({
    unitPriceMappings: productUnitPriceMappings,
    unitPriceDetailLabel: z.string().nullish(),
    ownershipEvidence: productOwnershipEvidenceOut,
    /** Published owner collection; null until a result is available. */
    owners: resolvedListSchema.nullable(),
    nutritionDisplay: productNutritionDisplay,
    // Same derived cover rule as `productTopLevelOut`/the picker (see
    // `getProductCoverImageUrlsByProductIds`) — not a stored field.
    coverImageUrl: output.shape.coverImageUrl,
    ingredient: productIngredientOut.nullable(),
    unitMappings: z.array(unitMappingOut),
    inventoryEntry: z.array(rawProductInventoryWithLocationOut),
    servingAsLocations: z.array(productLocationRefOut),
    /**
     * Live `productComponent` links where this product is the parent — non-zero
     * means it is a kit or multi-pack. Counts distinct components, not units.
     *
     * Embedded here rather than read from `product.components` beside it, for the
     * reason `servingAsLocations` gives above: the hero decides its presence
     * stamp from this, and a stamp that flipped when a second query resolved
     * would contradict the Kit Components table while it loaded.
     */
    componentCount: z.number().int().nonnegative(),
    food: foodSummary.nullable(),
    recipeUsages: z.array(recipeUsageOut),
    /** Live cookbooks whose physical copies are this product. */
    cookbooks: z.array(productCookbookRefOut),
    // Server-composed text for the External IDs detail row (`display.detailLabelPath`).
    externalIdsLabel: listLabel,
    ...productQuantityFields,
  });
  return { output, list, detail };
}
