/**
 * Wire types for a location sweep: scan a code while standing at a location,
 * and later commit the strays the sweep turned up.
 *
 * Their own module rather than a section of `inventory.ts` because the input
 * spans two domains — a product code and an inventory placement — and neither
 * domain schema should have to import the other to describe it.
 */

import { z } from "zod";
import { mutationSideEffectsSchema } from "./background-jobs";
import { amount, positiveAmount } from "./codec";
import {
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "./identifiers";
import { productFindOrCreateByCodeInput } from "./product";

/**
 * What a sweep can be pointed at.
 *
 * A barcode or ISBN may name a product that does not exist yet, so those
 * resolve through find-or-create. A `PRD-` label names one that certainly
 * does — Cubby printed it — so it resolves by lookup and never creates.
 * Without this variant, enabling QR would read Cubby's own product labels and
 * then reject them.
 */
export const scanAtLocationCode = z.union([
  productFindOrCreateByCodeInput,
  z.object({ kind: z.literal("product"), value: productShortcode }),
]);
export type ScanAtLocationCode = z.infer<typeof scanAtLocationCode>;

export const scanAtLocationInput = z.object({
  locationId: locationShortcode.describe("The location being swept."),
  code: scanAtLocationCode.describe("The scanned code."),
});
export type ScanAtLocationInput = z.infer<typeof scanAtLocationInput>;

/**
 * A live stock row of the scanned product sitting somewhere else. Reported,
 * never acted on mid-sweep — the whole point of deferring is that the camera
 * does not stop.
 */
export const scanStrayOut = z.object({
  entryId: inventoryShortcode,
  location: z.object({ id: locationShortcode, name: z.string() }),
  amount,
  ambiguousQuantity: z
    .boolean()
    .describe(
      "The source row holds more than one unit, so moving it whole would relocate stock the scan never accounted for. Needs an explicit move-one-or-all choice.",
    ),
});
export type ScanStrayOut = z.infer<typeof scanStrayOut>;

export const scanAtLocationOut = z.object({
  outcome: z
    .enum(["added", "confirmed", "queued"])
    .describe(
      "`added` created a row here; `confirmed` stamped an existing row as seen, leaving its amount alone; `queued` wrote nothing because the product only lives elsewhere.",
    ),
  product: z.object({
    id: productShortcode,
    name: z.string(),
    created: z.boolean(),
    /**
     * Enough to decide whether the scan is worth a curation prompt, without a
     * second fetch on the hot path. A brand-new UPC product often lands with a
     * placeholder name, no price, and no ingredient link — the last of which
     * makes it invisible to recipe costing.
     */
    manufacturer: z.string().nullable(),
    hasPrice: z.boolean(),
  }),
  strays: z.array(scanStrayOut),
  sideEffects: mutationSideEffectsSchema,
});
export type ScanAtLocationOut = z.infer<typeof scanAtLocationOut>;

export const resolveScanStraysInput = z.object({
  targetLocationId: locationShortcode,
  moves: z
    .array(
      z.object({
        entryId: inventoryShortcode,
        /** Omitted moves the whole row — the right default for a single unit. */
        quantity: positiveAmount.optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type ResolveScanStraysInput = z.infer<typeof resolveScanStraysInput>;

export const resolveScanStraysOut = z.object({
  moved: z.number().int(),
  /**
   * A stray whose source row a previous move in this same batch already
   * consumed. Reported rather than thrown: one item genuinely arriving is not
   * a reason to fail the other fifty.
   */
  skipped: z.array(
    z.object({ entryId: inventoryShortcode, reason: z.string() }),
  ),
  sideEffects: mutationSideEffectsSchema,
});
export type ResolveScanStraysOut = z.infer<typeof resolveScanStraysOut>;
