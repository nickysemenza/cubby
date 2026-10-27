/**
 * Wire types for a location sweep: scan a code while standing at a location,
 * and later commit the strays the sweep turned up.
 *
 * Their own module rather than a section of `inventory.ts` because the input
 * spans two domains — a product code and an inventory placement — and neither
 * domain schema should have to import the other to describe it.
 */

import { z } from "zod";
import {
  rawScanStray,
  rawScanProduct,
  rawScanAtLocation,
} from "./scan-raw-read";
import { withFieldEnvelopes } from "./field-envelope";
import {
  productFieldEnvelopeFields,
  productPublicReadFields,
} from "./generated/entity-field-envelope-fields.product.gen";
import {
  inventoryFieldEnvelopeFields,
  inventoryPublicReadFields,
} from "./generated/entity-field-envelope-fields.inventory.gen";
import { mutationSideEffectsSchema } from "./mutation-side-effects";
import { positiveAmount } from "./codec";
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
 * then reject them. A raw `scan` (inherited from the product input) is
 * classified server-side into one of the other three.
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
export const scanStrayOut = withFieldEnvelopes(
  rawScanStray,
  inventoryFieldEnvelopeFields,
  inventoryPublicReadFields,
);
export type ScanStrayOut = z.output<typeof scanStrayOut>;
export const scanProductOut = withFieldEnvelopes(
  rawScanProduct,
  productFieldEnvelopeFields,
  productPublicReadFields,
);
export const scanAtLocationOut = rawScanAtLocation
  .omit({ product: true, strays: true })
  .extend({
    product: scanProductOut,
    strays: z.array(scanStrayOut),
  });
export type ScanAtLocationOut = z.infer<typeof scanAtLocationOut>;

export const resolveScanStraysInput = z.object({
  targetLocationId: locationShortcode,
  moves: z
    .array(
      z.object({
        entryId: inventoryShortcode,
        quantity: positiveAmount.optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type ResolveScanStraysInput = z.infer<typeof resolveScanStraysInput>;

/**
 * Why a queued stray did not move. Structured, not prose, so a caller can
 * branch on it — `message` carries the sentence. Same split as
 * `describeToolError`'s `{code, reason, message}`.
 */
export const scanStraySkipReason = z.enum([
  /** The source row is gone: a prior move in this batch consumed it. */
  "already-moved",
  "already-here",
]);
export type ScanStraySkipReason = z.infer<typeof scanStraySkipReason>;

export const resolveScanStraysOut = z.object({
  moved: z.number().int().nonnegative(),
  /**
   * Strays that did not move. Reported rather than thrown: a full move onto an
   * existing destination row HARD-deletes its source, so by commit time a
   * queued id can legitimately no longer exist — and one stale row is no
   * reason to strand the other fifty.
   */
  skipped: z.array(
    z.object({
      entryId: inventoryShortcode,
      reason: scanStraySkipReason,
      message: z.string(),
    }),
  ),
  sideEffects: mutationSideEffectsSchema,
});
export type ResolveScanStraysOut = z.infer<typeof resolveScanStraysOut>;
