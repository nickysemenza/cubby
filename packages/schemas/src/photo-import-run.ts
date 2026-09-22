import { z } from "zod";

import {
  imageShortcode,
  importRunShortcode,
  inventoryShortcode,
  ledgerPartyShortcode,
  locationShortcode,
  productCategoryShortcode,
  productShortcode,
} from "./identifier-fields";
import { importRunStatus } from "./import-run-fields";
import { productImagePurpose } from "./image";
import { inventoryOwnershipMode } from "./inventory-ownership";
import { importRunTargetState } from "./purchase-import";

const commitPhotoGroupImage = z.object({
  id: imageShortcode,
  purpose: productImagePurpose,
});

const commitPhotoGroupSkip = z.object({
  id: imageShortcode,
  reason: z.string().trim().min(1).max(500),
});

const commitPhotoGroupProductCreate = z.object({
  name: z.string().trim().min(1).max(500),
  categoryId: productCategoryShortcode.nullable().optional(),
  manufacturer: z.string().trim().max(300).optional(),
  model: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(4_000).nullable().optional(),
  tags: z.array(z.string().trim().min(1)).max(50).optional(),
});

export const commitPhotoGroupProduct = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), existingId: productShortcode }),
  z.object({
    kind: z.literal("create"),
    create: commitPhotoGroupProductCreate,
  }),
]);
export type CommitPhotoGroupProduct = z.infer<typeof commitPhotoGroupProduct>;

/**
 * `ownershipMode` and `ownerPartyId` are both optional so a caller can omit
 * ownership entirely and let the writer default to `person` ownership under
 * the run's own member. Naming `ownershipMode: "person"` WITHOUT `ownerPartyId`
 * is a distinct, deliberately refused shape — the caller said "a person owns
 * this" but not who, and the writer never silently guesses in that case; only
 * a fully omitted ownership selection defaults.
 */
const commitPhotoGroupInventory = z.object({
  locationId: locationShortcode,
  ownershipMode: inventoryOwnershipMode.optional(),
  ownerPartyId: ledgerPartyShortcode.optional(),
  quantity: z.number().int().positive(),
});
export type CommitPhotoGroupInventory = z.infer<
  typeof commitPhotoGroupInventory
>;

const commitPhotoGroupInputBase = z.object({
  runId: importRunShortcode,
  groupKey: z.string().trim().min(1).max(200),
  // No `.min(1)`: a group may be skip-only (every image rejected, none
  // attached) — the cross-field check below requires only that `images` and
  // `skip` together are non-empty.
  images: z.array(commitPhotoGroupImage).max(50).default([]),
  product: commitPhotoGroupProduct,
  inventory: commitPhotoGroupInventory.optional(),
  skip: z.array(commitPhotoGroupSkip).max(50).optional(),
});

export const commitPhotoGroupInput = commitPhotoGroupInputBase.superRefine(
  (value, ctx) => {
    const attached = new Set(value.images.map((image) => image.id));
    const skipped = new Set((value.skip ?? []).map((image) => image.id));
    if (attached.size === 0 && skipped.size === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["images"],
        message: "A group needs at least one image, attached or skipped",
      });
    }
    for (const id of attached) {
      if (skipped.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["skip"],
          message: `Image ${id} appears in both images and skip`,
        });
      }
    }
    if (attached.size !== value.images.length) {
      ctx.addIssue({
        code: "custom",
        path: ["images"],
        message: "Duplicate image id within images",
      });
    }
    if (skipped.size !== (value.skip ?? []).length) {
      ctx.addIssue({
        code: "custom",
        path: ["skip"],
        message: "Duplicate image id within skip",
      });
    }
  },
);
export type CommitPhotoGroupInput = z.infer<typeof commitPhotoGroupInput>;

export const commitPhotoGroupOutcome = z.enum([
  "committed",
  "replayed",
  "conflict",
]);
export type CommitPhotoGroupOutcome = z.infer<typeof commitPhotoGroupOutcome>;

const commitPhotoGroupOutputImage = z.object({
  id: imageShortcode,
  state: importRunTargetState,
});

export const commitPhotoGroupOutput = z.object({
  runId: importRunShortcode,
  groupKey: z.string().trim().min(1).max(200),
  outcome: commitPhotoGroupOutcome,
  productId: productShortcode.optional(),
  inventoryId: inventoryShortcode.optional(),
  images: z.array(commitPhotoGroupOutputImage),
  conflict: z
    .object({ existingProductIds: z.array(productShortcode) })
    .optional(),
  runStatus: importRunStatus,
});
export type CommitPhotoGroupOutput = z.infer<typeof commitPhotoGroupOutput>;

// Native upload side of a photo-inventory run. These live here rather than in
// the web contract so the OpenAPI document names them after their exports.
export const photoImportCreateRunInput = z.object({
  ledgerPartyId: ledgerPartyShortcode.optional(),
  notes: z.string().max(2_000).optional(),
});
export const photoImportCreateRunOutput = z.object({
  runId: importRunShortcode,
});

export const photoImportFinalizeImage = z.object({
  imageId: imageShortcode,
  position: z.int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.int().positive(),
  height: z.int().positive(),
});
export const photoImportFinalizeInput = z.object({
  runId: importRunShortcode,
  images: z.array(photoImportFinalizeImage).min(1).max(100),
});
export const photoImportFinalizeOutput = z.object({
  finalized: z.array(imageShortcode),
  alreadyFinalized: z.array(imageShortcode),
  submissionId: z.string(),
});
