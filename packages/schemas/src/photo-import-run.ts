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
import { imageProcessingJobState } from "./image-processing";
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

export type CommitPhotoGroupProductCreate = z.infer<
  typeof commitPhotoGroupProductCreate
>;

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
/** What a proposal stores beside its `inventoryLocationId` FK column. */
export type PhotoGroupStoredInventory = Omit<
  CommitPhotoGroupInventory,
  "locationId"
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

type GroupImageRoster = {
  images: { id: string }[];
  skip?: { id: string }[] | undefined;
};

/** Shared by the direct writer and a proposal: attach and skip are disjoint, each duplicate-free, and not both empty. */
function refineGroupImageRoster(value: GroupImageRoster, ctx: z.RefinementCtx) {
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
}

export const commitPhotoGroupInput = commitPhotoGroupInputBase.superRefine(
  refineGroupImageRoster,
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

/**
 * A proposed group waits for human review on the run page; approving it runs
 * `commit_photo_group` with the same payload. `committed` and `discarded`
 * rows are frozen — their groupKey and image roster never change again.
 */
export const photoGroupProposalState = z.enum([
  "proposed",
  "committed",
  "discarded",
]);
export type PhotoGroupProposalState = z.infer<typeof photoGroupProposalState>;

export const photoGroupProposalGroup = commitPhotoGroupInputBase
  .omit({ runId: true })
  .extend({
    /** Why these photos are one item and why this Product — shown to the reviewer. */
    evidence: z.string().trim().max(4_000).nullable().optional(),
  })
  .superRefine(refineGroupImageRoster);
export type PhotoGroupProposalGroup = z.infer<typeof photoGroupProposalGroup>;

export const proposePhotoGroupsInput = z
  .object({
    runId: importRunShortcode,
    groups: z.array(photoGroupProposalGroup).max(200).default([]),
    /** Proposed groups to drop entirely (their images become unassigned). */
    removeGroupKeys: z
      .array(z.string().trim().min(1).max(200))
      .max(200)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.groups.length === 0 && !value.removeGroupKeys?.length) {
      ctx.addIssue({
        code: "custom",
        path: ["groups"],
        message: "Propose at least one group or remove at least one groupKey",
      });
    }
    const keys = new Set(value.groups.map((group) => group.groupKey));
    if (keys.size !== value.groups.length) {
      ctx.addIssue({
        code: "custom",
        path: ["groups"],
        message: "Duplicate groupKey within groups",
      });
    }
    for (const key of value.removeGroupKeys ?? []) {
      if (keys.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["removeGroupKeys"],
          message: `Group ${key} is both proposed and removed`,
        });
      }
    }
  });
export type ProposePhotoGroupsInput = z.infer<typeof proposePhotoGroupsInput>;

const proposalProductSummary = z.object({
  id: productShortcode,
  name: z.string(),
  coverUrl: z.string().nullable(),
});
export type PhotoGroupProposalProductSummary = z.infer<
  typeof proposalProductSummary
>;

export const photoGroupProposal = z.object({
  groupKey: z.string(),
  state: photoGroupProposalState,
  images: z.array(commitPhotoGroupImage),
  skip: z.array(commitPhotoGroupSkip),
  product: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("existing"),
      /** Null only when the chosen Product was deleted after proposing. */
      existing: proposalProductSummary.nullable(),
    }),
    z.object({
      kind: z.literal("create"),
      create: commitPhotoGroupProductCreate,
    }),
  ]),
  /** The Product the approved group attached to (existing or newly created). */
  committedProduct: proposalProductSummary.nullable(),
  inventory: z
    .object({
      /** Null only when the chosen Location was deleted after proposing. */
      locationId: locationShortcode.nullable(),
      locationName: z.string().nullable(),
      ownershipMode: inventoryOwnershipMode.optional(),
      ownerPartyId: ledgerPartyShortcode.optional(),
      quantity: z.number().int().positive(),
    })
    .nullable(),
  evidence: z.string().nullable(),
  /** Live Products whose name/alias collided on the last approval attempt. */
  conflict: z.array(proposalProductSummary).nullable(),
  lastError: z.string().nullable(),
  committedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type PhotoGroupProposal = z.infer<typeof photoGroupProposal>;

export const photoGroupProposalList = z.object({
  runId: importRunShortcode,
  runStatus: importRunStatus,
  proposals: z.array(photoGroupProposal),
  /** Pending run images no `proposed` group mentions yet. */
  unassignedImageIds: z.array(imageShortcode),
});
export type PhotoGroupProposalList = z.infer<typeof photoGroupProposalList>;

export const proposePhotoGroupsOutput = photoGroupProposalList.extend({
  /** Requested groupKeys that name a committed or discarded group; left untouched. */
  frozenGroupKeys: z.array(z.string()),
});
export type ProposePhotoGroupsOutput = z.infer<typeof proposePhotoGroupsOutput>;

export const listPhotoGroupProposalsInput = z.object({
  runId: importRunShortcode,
});

export const reviewPhotoGroupsAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    groups: z.array(photoGroupProposalGroup).max(200).default([]),
    removeGroupKeys: z
      .array(z.string().trim().min(1).max(200))
      .max(200)
      .optional(),
  }),
  z.object({
    action: z.literal("approve"),
    /** Omit to approve every `proposed` group. */
    groupKeys: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  }),
  z.object({
    action: z.literal("discard"),
    groupKey: z.string().trim().min(1).max(200),
  }),
]);
export type ReviewPhotoGroupsAction = z.infer<typeof reviewPhotoGroupsAction>;

export const photoGroupApprovalResult = z.object({
  groupKey: z.string(),
  outcome: z.enum(["committed", "replayed", "conflict", "failed"]),
  error: z.string().optional(),
});
export type PhotoGroupApprovalResult = z.infer<typeof photoGroupApprovalResult>;

export const reviewPhotoGroupsOutput = photoGroupProposalList.extend({
  results: z.array(photoGroupApprovalResult),
});
export type ReviewPhotoGroupsOutput = z.infer<typeof reviewPhotoGroupsOutput>;

/** One run photo as the review table shows it: both renditions and where processing stands. */
export const photoRunImage = z.object({
  id: imageShortcode,
  position: z.number().int().nullable(),
  targetState: importRunTargetState,
  originalUrl: z.string(),
  cutoutUrl: z.string().nullable(),
  /** Current-source subject-lift and description job states; null = never queued. */
  cutout: imageProcessingJobState.nullable(),
  describe: imageProcessingJobState.nullable(),
  /** The cutout processor's skip or failure reason, e.g. `not_suitable`. */
  cutoutReason: z.string().nullable(),
  description: z.string().nullable(),
  recognizedText: z.string().nullable(),
});
export type PhotoRunImage = z.infer<typeof photoRunImage>;

/** The run page's review read: proposals plus every run photo. */
export const photoRunReviewResponse = z.object({
  review: photoGroupProposalList,
  images: z.array(photoRunImage),
});
export type PhotoRunReview = z.infer<typeof photoRunReviewResponse>;

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
