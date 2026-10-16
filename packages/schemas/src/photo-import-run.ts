import { APPLE_APP_IDENTITIES } from "@cubby/shared/apple-app-identity";
import { z } from "zod";

import {
  imageShortcode,
  runShortcode,
  inventoryShortcode,
  ledgerPartyShortcode,
  locationShortcode,
  productCategoryShortcode,
  productShortcode,
  expenseShortcode,
  purchaseShortcode,
} from "./identifier-fields";
import { decisionStep } from "./decision-step";
import { userId } from "./identifiers";
import { runStatus } from "./run-fields";
import { purchaseImportRunExecution } from "./purchase-import";
import { productImagePurpose } from "./image";
import { imageSightingReportFields } from "./image-sighting";
import { photoRunProcessor } from "./photo-run-input";
import { selectedImageDescriptionEvidence } from "./image-processing";
import { imageProcessingJobState } from "./image-processing";
import { inventoryOwnershipMode } from "./inventory-ownership";
import { runTargetState } from "./purchase-import";
import { productVariantComparison } from "./product-variant-comparison";
import {
  productListInventoryEntryOut,
  productQuantitySummaryOut,
} from "./product";

export const runTargetDeviceWorkState = z.enum([
  "queued",
  "running",
  "paused",
  "failed",
  "completed",
]);
export type RunTargetDeviceWorkState = z.infer<typeof runTargetDeviceWorkState>;

export const photoRunImageState = z.enum([
  "pending",
  "prepared",
  "completed",
  "skipped",
  "unresolved",
  "needs_evidence",
  "unavailable",
]);
export type PhotoRunImageState = z.infer<typeof photoRunImageState>;
export const photoRunImageOutcome = z.enum(["attached", "skipped"]);
export type PhotoRunImageOutcome = z.infer<typeof photoRunImageOutcome>;
/** A committed group's receipt survives a failed operation-ledger completion. */
export const photoRunImageCommitReceipt = z.object({
  groupKey: z.string().min(1),
  productId: productShortcode.optional(),
  purpose: productImagePurpose.optional(),
  inventoryId: inventoryShortcode.optional(),
});
export type PhotoRunImageCommitReceipt = z.infer<
  typeof photoRunImageCommitReceipt
>;

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

/** Observed identity stays independent of the selected catalog destination. */
export const photoGroupReview = z.object({
  observedName: z.string().trim().min(1).max(500),
  unresolvedReason: z.string().trim().min(1).max(500).nullable(),
  stockIntent: z.enum(["evidence", "counted", "historical", "receive"]),
  productChanges: commitPhotoGroupProductCreate.partial().optional(),
  /** Written by the server only after the Product transaction succeeds. */
  confirmation: z
    .object({ by: userId, at: z.iso.datetime() })
    .nullable()
    .optional(),
  /** Server-maintained photo lineage carries candidate rejections through regrouping. */
  candidateScopeImageIds: z.array(imageShortcode).optional(),
  resolvedConcerns: z
    .array(
      z.object({
        reason: z.string(),
        reply: z.string().nullable(),
        by: userId,
        at: z.iso.datetime(),
      }),
    )
    .optional(),
});
export type PhotoGroupReview = z.infer<typeof photoGroupReview>;

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
 * ownership entirely and let the writer default to `explicit` ownership under
 * the run's own member. Naming `ownershipMode: "explicit"` WITHOUT the
 * `ownerPartyId` key is a distinct, deliberately refused shape — the caller
 * chose an owner but not who, and the writer never silently guesses in that
 * case; `ownerPartyId: null` names household stock. Only a fully omitted
 * ownership selection defaults.
 */
const commitPhotoGroupInventory = z.object({
  locationId: locationShortcode,
  ownershipMode: inventoryOwnershipMode.optional(),
  ownerPartyId: ledgerPartyShortcode.nullable().optional(),
  quantity: z.number().int().positive(),
  mode: z.enum(["create", "add"]).optional(),
  existingEntryId: inventoryShortcode.optional(),
});
export type CommitPhotoGroupInventory = z.infer<
  typeof commitPhotoGroupInventory
>;
/**
 * What a proposal stores beside its `inventoryLocationId` and
 * `inventoryOwnerPartyId` FK columns.
 */
export type PhotoGroupStoredInventory = Omit<
  CommitPhotoGroupInventory,
  "locationId" | "ownerPartyId"
>;

/** The writer's per-call cap on `images` and on `skip`. */
const PROPOSAL_IMAGE_LIMIT = 50;

const commitPhotoGroupInputBase = z.object({
  runId: runShortcode,
  groupKey: z.string().trim().min(1).max(200),
  // No `.min(1)`: a group may be skip-only (every image rejected, none
  // attached) — the cross-field check below requires only that `images` and
  // `skip` together are non-empty.
  images: z.array(commitPhotoGroupImage).max(PROPOSAL_IMAGE_LIMIT).default([]),
  product: commitPhotoGroupProduct,
  review: photoGroupReview.optional(),
  inventory: commitPhotoGroupInventory.optional(),
  skip: z.array(commitPhotoGroupSkip).max(PROPOSAL_IMAGE_LIMIT).optional(),
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

export const commitPhotoGroupInput = commitPhotoGroupInputBase
  .extend({ _runExecution: purchaseImportRunExecution.optional() })
  .superRefine(refineGroupImageRoster);
export type CommitPhotoGroupInput = z.infer<typeof commitPhotoGroupInput>;

export const commitPhotoGroupOutcome = z.enum([
  "committed",
  "replayed",
  "conflict",
]);
export type CommitPhotoGroupOutcome = z.infer<typeof commitPhotoGroupOutcome>;

const commitPhotoGroupOutputImage = z.object({
  id: imageShortcode,
  state: runTargetState,
});

export const commitPhotoGroupOutput = z.object({
  runId: runShortcode,
  groupKey: z.string().trim().min(1).max(200),
  outcome: commitPhotoGroupOutcome,
  productId: productShortcode.optional(),
  inventoryId: inventoryShortcode.optional(),
  images: z.array(commitPhotoGroupOutputImage),
  conflict: z
    .object({ existingProductIds: z.array(productShortcode) })
    .optional(),
  runStatus: runStatus,
});
export type CommitPhotoGroupOutput = z.infer<typeof commitPhotoGroupOutput>;

/**
 * A proposed group waits for human review on the run page; approving it runs
 * `photo_run.commit_group` with the same payload. `committed` and `discarded`
 * rows are frozen — their groupKey and image roster never change again.
 */
export const photoGroupProposalState = z.enum([
  "proposed",
  "committed",
  "discarded",
]);
export type PhotoGroupProposalState = z.infer<typeof photoGroupProposalState>;

/**
 * Who last wrote a proposal's payload: the Run's Pi coordinator, an external
 * Claude/Codex session over MCP, or the member's own review edit. Honest
 * last-writer metadata only — no proposal field is a Jev/Clef suggestion.
 * Null on rows written before the origin was recorded.
 */
export const photoGroupProposalOrigin = z.enum([
  "coordinator",
  "external_agent",
  "member",
]);
export type PhotoGroupProposalOrigin = z.infer<typeof photoGroupProposalOrigin>;

export const photoGroupProposalGroup = commitPhotoGroupInputBase
  .omit({ runId: true })
  .extend({
    /** Why these photos are one item and why this Product — shown to the reviewer. */
    evidence: z.string().trim().max(4_000).nullable().optional(),
  })
  .superRefine(refineGroupImageRoster)
  .superRefine((value, ctx) => {
    // Discarding a proposal commits every image it holds as one `skip` list,
    // which the writer caps at the same limit — so a proposal may not hold
    // more than that across `images` and `skip` together.
    const total = value.images.length + (value.skip ?? []).length;
    if (total > PROPOSAL_IMAGE_LIMIT) {
      ctx.addIssue({
        code: "custom",
        path: ["images"],
        message: `Group ${value.groupKey} holds ${total} photos; a proposed group holds at most ${PROPOSAL_IMAGE_LIMIT} counting attached and skipped photos together`,
      });
    }
  });
export type PhotoGroupProposalGroup = z.infer<typeof photoGroupProposalGroup>;

export const proposePhotoGroupsInput = z
  .object({
    runId: runShortcode,
    _runExecution: purchaseImportRunExecution.optional(),
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

export const photoFieldCrossCheck = z.object({
  field: z.enum([
    "name",
    "manufacturer",
    "model",
    "identifiers",
    "color",
    "size",
  ]),
  mark: z.enum(["agree", "disagree-or-missing", "unknown"]),
  source: z.enum(["deterministic", "model"]),
  tokens: z.array(
    z.object({
      text: z.string(),
      mark: z.enum(["agree", "disagree-or-missing", "unknown"]),
    }),
  ),
});
export type PhotoFieldCrossCheck = z.infer<typeof photoFieldCrossCheck>;

export const photoGroupProposal = z.object({
  groupKey: z.string(),
  steps: z.array(decisionStep),
  crossCheck: z.array(photoFieldCrossCheck).optional(),
  blockedReason: z.string().nullable(),
  review: photoGroupReview.optional(),
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
  committedInventoryId: inventoryShortcode.nullable().optional(),
  inventory: z
    .object({
      /** Null only when the chosen Location was deleted after proposing. */
      locationId: locationShortcode.nullable(),
      locationName: z.string().nullable(),
      ownershipMode: inventoryOwnershipMode.optional(),
      ownerPartyId: ledgerPartyShortcode.nullable().optional(),
      quantity: z.number().int().positive(),
      mode: z.enum(["create", "add"]).optional(),
      existingEntryId: inventoryShortcode.optional(),
    })
    .nullable(),
  evidence: z.string().nullable(),
  /** Last writer of this payload; null = written before origin was recorded. */
  origin: photoGroupProposalOrigin.nullable(),
  /** Live Products whose name/alias collided on the last approval attempt. */
  conflict: z.array(proposalProductSummary).nullable(),
  lastError: z.string().nullable(),
  /**
   * Photos this group named that were since deleted (their run target went
   * with them). They are left out of `images`/`skip` and of any approval.
   */
  missingImageCount: z.number().int().nonnegative(),
  committedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type PhotoGroupProposal = z.infer<typeof photoGroupProposal>;

export const photoGroupProposalList = z.object({
  runId: runShortcode,
  runStatus: runStatus,
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
  runId: runShortcode,
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
    expectedRevisions: z
      .array(
        z.object({ groupKey: z.string().min(1), updatedAt: z.iso.datetime() }),
      )
      .max(200)
      .optional(),
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
  /** From a `save`: groupKeys already committed or discarded, left untouched. */
  frozenGroupKeys: z.array(z.string()),
});
export type ReviewPhotoGroupsOutput = z.infer<typeof reviewPhotoGroupsOutput>;

/** One run photo as the review table shows it: both renditions and where processing stands. */
export const photoRunImage = z.object({
  id: imageShortcode,
  position: z.number().int().nullable(),
  /** When the photo was taken, the run's sort key; null sorts last. */
  capturedAt: z.iso.datetime().nullable(),
  /** The camera's UTC offset at capture, for reading `capturedAt` as local time. */
  capturedAtOffsetMinutes: z.number().int().nullable(),
  targetState: runTargetState,
  /** Why a `skipped` photo was left out; the Image itself is kept. */
  skipReason: z.string().nullable(),
  originalUrl: z.string(),
  cutoutUrl: z.string().nullable(),
  /** Current-source subject-lift and description job states; null = never queued. */
  cutout: imageProcessingJobState.nullable(),
  describe: imageProcessingJobState.nullable(),
  /** The current description job's dispatch-to-completion interval, if recorded. */
  describeStartedAt: z.iso.datetime().nullable(),
  describeCompletedAt: z.iso.datetime().nullable(),
  /** Sum of completed execution attempts; includes executor network latency. */
  describeAttemptMs: z.number().nonnegative().nullable(),
  /** Dispatch-to-completion time outside completed attempts. */
  describeWaitingMs: z.number().nonnegative().nullable(),
  /** True after the device has submitted its local Vision analysis. */
  localAnalysisReady: z.boolean(),
  /** The cutout processor's skip or failure reason, e.g. `not_suitable`. */
  cutoutReason: z.string().nullable(),
  describeReason: z.string().nullable(),
  description: z.string().nullable(),
  descriptionEvidence: selectedImageDescriptionEvidence.optional(),
  recognizedText: z.string().nullable(),
  /** Device-reported processing state for this photo; null = no device has picked it up yet. */
  deviceWorkState: runTargetDeviceWorkState.nullable(),
  deviceWorkError: z.string().nullable(),
  deviceWorkAttempts: z.number().int().nonnegative(),
});
export type PhotoRunImage = z.infer<typeof photoRunImage>;

/**
 * The agent's per-photo summary in `imports_read.photo_context`. Every field is
 * carried in each later model call, so timings and cutout state are left out
 * and image URLs are opt-in.
 */
export const photoRunContextImage = photoRunImage
  .pick({
    id: true,
    position: true,
    capturedAt: true,
    capturedAtOffsetMinutes: true,
    targetState: true,
    describe: true,
    description: true,
    descriptionEvidence: true,
    recognizedText: true,
  })
  .extend({
    /** Present only with `withImageUrls`, for a caller that can view images. */
    originalUrl: z.string().optional(),
    cutoutUrl: z.string().nullable().optional(),
  });

export const photoAcceptedSourceLine = z.object({
  sourceOrderId: z.uuid(),
  lineIndex: z.number().int().nonnegative(),
});
export type PhotoAcceptedSourceLine = z.infer<typeof photoAcceptedSourceLine>;

export const photoProductCandidate = z.object({
  id: productShortcode,
  name: z.string(),
  coverUrl: z.string().nullable(),
  /** Deterministic catalogue matching, not an agent or model decision. */
  match: z.object({
    source: z.literal("catalog_name"),
    sharedNameTerms: z.array(z.string()),
    brandMatches: z.boolean(),
    variant: productVariantComparison,
    score: z.number().optional(),
    factors: z
      .array(z.object({ label: z.string(), points: z.number() }))
      .optional(),
    matchedIdentifiers: z.array(z.string()).optional(),
  }),
  duplicateStrength: z.enum(["strong", "weak"]).optional(),
  crossCheck: z.array(photoFieldCrossCheck).optional(),
  hasOwnPhoto: z.boolean(),
  hasPhotoImport: z.boolean(),
  hasPurchase: z.boolean(),
  hasInventory: z.boolean(),
  quantity: productQuantitySummaryOut.optional(),
  inventoryEntries: z.array(productListInventoryEntryOut).optional(),
  ownPhotos: z
    .array(
      z.object({
        id: imageShortcode,
        url: z.string(),
        capturedAt: z.string().nullable().optional(),
      }),
    )
    .optional(),
  variantEvidence: z
    .array(
      z.object({
        text: z.string(),
        source: z.enum([
          "proposal_name",
          "photo_description",
          "label_ocr",
          "product_name",
          "product_model",
          "product_alias",
          "purchase_line",
        ]),
      }),
    )
    .optional(),
  purchaseLines: z
    .array(
      z.object({
        expenseId: expenseShortcode,
        purchaseId: purchaseShortcode.nullable(),
        purchaseLabel: z.string().nullable(),
        name: z.string(),
        date: z.string().nullable(),
        dateLabel: z.enum(["Ordered", "Paid"]).optional(),
        vendor: z.string().nullable().optional(),
        cost: z.number().nullable(),
        productQuantity: z.number().nullable(),
        movement: z.enum(["acquired", "exited", "adjusted", "unknown"]),
        acceptedSourceLines: z.array(photoAcceptedSourceLine).optional(),
      }),
    )
    .optional(),
  purchaseLineCount: z.number().int().nonnegative().optional(),
});
export type PhotoProductCandidate = z.infer<typeof photoProductCandidate>;

export const photoProductEvidence = photoProductCandidate
  .pick({
    id: true,
    name: true,
    coverUrl: true,
    quantity: true,
    inventoryEntries: true,
    ownPhotos: true,
    purchaseLines: true,
    purchaseLineCount: true,
  })
  .extend({
    manufacturer: z.string().nullable(),
    model: z.string().nullable(),
    identifiers: z.array(z.string()),
  });
export type PhotoProductEvidence = z.infer<typeof photoProductEvidence>;
export const photoRejectedCandidate = z.object({
  id: productShortcode,
  name: z.string(),
  rejected: z.literal(true),
});
export const photoCandidateGroupResult = z.object({
  groupKey: z.string(),
  status: z.enum(["ready", "failed"]),
  error: z.string().nullable(),
  selectedComparison: z
    .object({
      id: productShortcode,
      variant: productVariantComparison,
      crossCheck: z.array(photoFieldCrossCheck),
    })
    .nullable()
    .optional(),
  candidates: z.array(photoProductCandidate),
  rejectedCandidates: z.array(photoRejectedCandidate),
});
export const photoRunCandidatesResponse = z.object({
  groups: z.array(photoCandidateGroupResult),
});

export const photoProductCandidatesResponse = z.object({
  candidates: z.array(photoProductCandidate),
  rejectedCandidates: z.array(photoRejectedCandidate).optional(),
  status: z.enum(["ready", "failed"]).optional(),
  error: z.string().nullable().optional(),
});
export const photoProductCandidateSearchInput = z.object({
  name: z.string().trim().min(3).max(500),
  manufacturer: z.string().trim().max(300).optional(),
});

export {
  storedPhotoRunInput,
  photoInventoryRunInput,
  type PhotoInventoryRunInput,
  photoRunProcessor,
  type PhotoRunProcessor,
  photoRunUploadBatch,
  type PhotoRunUploadBatch,
} from "./photo-run-input";

/**
 * Where a photo Run stands, derived on every read from durable rows:
 * - `waiting_for_upload`: an admitted upload batch is not sealed yet.
 * - `describing`: required photo descriptions are queued or running.
 * - `needs_attention`: a description failed; continue without those photos
 *   (`excludeFailed`) or retry them.
 * - `grouping`: the Pi coordinator is grouping (cubby).
 * - `ready_for_handoff`: descriptions settled; copy the prompt to Claude/Codex (external).
 * - `ready_for_review`: proposals wait for member approval.
 * - `completed`: nothing pending remains.
 */
export const photoRunLifecyclePhase = z.enum([
  "waiting_for_upload",
  "describing",
  "needs_attention",
  "grouping",
  "ready_for_handoff",
  "ready_for_review",
  "completed",
]);
export type PhotoRunLifecyclePhase = z.infer<typeof photoRunLifecyclePhase>;

export const photoRunLifecycle = z.object({
  /** Null on a legacy Run created before the choice existed (manual grouping). */
  processor: photoRunProcessor.nullable(),
  phase: photoRunLifecyclePhase,
  /** Photos every admitted batch planned; null on a legacy Run. */
  plannedImageCount: z.number().int().nonnegative().nullable(),
  /** Admitted batches not yet sealed; grouping waits for zero. */
  openBatchCount: z.number().int().nonnegative(),
  /** Finalized run targets, whatever their state. */
  finalizedImageCount: z.number().int().nonnegative(),
  /** Pending photos whose description is ready, skipped, or not required. */
  describedImageCount: z.number().int().nonnegative(),
  /** Pending photos whose description failed; they block automatic grouping. */
  failedImageIds: z.array(imageShortcode),
  /** Photos skipped with a reason (kept, never deleted). */
  skippedImageCount: z.number().int().nonnegative(),
  proposedGroupCount: z.number().int().nonnegative(),
  committedGroupCount: z.number().int().nonnegative(),
  /** The last coordinator dispatch failure, verbatim. */
  dispatchError: z.string().nullable(),
});
export type PhotoRunLifecycle = z.infer<typeof photoRunLifecycle>;

/** The run page's review read: proposals plus every run photo. */
export const photoRunReviewResponse = z.object({
  review: photoGroupProposalList,
  images: z.array(photoRunImage),
  /** Household image work is paused, so queued descriptions wait and grouping cannot start. */
  imageProcessingPaused: z.boolean(),
  lifecycle: photoRunLifecycle,
});
export type PhotoRunReview = z.infer<typeof photoRunReviewResponse>;

// Native upload side of a photo-inventory run. These live here rather than in
// the web contract so the OpenAPI document names them after their exports.
export const photoImportCreateRunInput = z.object({
  ledgerPartyId: ledgerPartyShortcode.optional(),
  notes: z.string().max(2_000).optional(),
  processor: photoRunProcessor,
  /**
   * The first batch's durable client UUID. It is also the Run's idempotency
   * key: resending the same id returns the Run already created.
   */
  clientBatchId: z.uuid(),
  /** Photos the first batch plans to finalize (progress only). */
  imageCount: z.int().positive(),
});
export const photoImportCreateRunOutput = z.object({
  runId: runShortcode,
});

/**
 * Admit another batch into an existing Run before uploading it; replaying a
 * `clientBatchId` changes nothing. A new batch on a `cubby` Run fences the
 * active coordinator generation and drops every still-`proposed` group, so
 * the next generation regroups all unapproved photos; committed and
 * discarded groups stay frozen.
 */
export const photoImportAdmitBatchInput = z.object({
  runId: runShortcode,
  clientBatchId: z.uuid(),
  imageCount: z.int().positive(),
});
/**
 * Close a batch after its last finalize chunk, or when the uploader gives up
 * on its remaining photos. Omit `clientBatchId` to close every open batch
 * (a member continuing with the photos already uploaded). Idempotent.
 */
export const photoImportSealBatchInput = z.object({
  runId: runShortcode,
  clientBatchId: z.uuid().optional(),
});
export const photoRunLifecycleOutput = z.object({
  runId: runShortcode,
  lifecycle: photoRunLifecycle,
});
/** Positions in this batch's finalize calls are `positionOffset + index`. */
export const photoImportAdmitBatchOutput = photoRunLifecycleOutput.extend({
  clientBatchId: z.uuid(),
  positionOffset: z.int().nonnegative(),
});

export const photoRunSetProcessorInput = z.object({
  runId: runShortcode,
  processor: photoRunProcessor,
});

/**
 * Continue without photos whose description failed: each becomes a `skipped`
 * run target with this reason. The Image and its bytes are kept.
 */
export const photoRunExcludeFailedInput = z.object({
  runId: runShortcode,
  imageIds: z.array(imageShortcode).min(1).max(500),
});

export const photoImportFinalizeImage = z.object({
  imageId: imageShortcode,
  position: z.int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.int().positive(),
  height: z.int().positive(),
  /**
   * This device's library facts about the asset (capture date and offset,
   * location, camera, asset key), recorded as an `import` ImageSighting so
   * the Image's capture fields are durable without local Vision analysis.
   * Same block as the manifest commit's `library`.
   */
  library: imageSightingReportFields.optional(),
});
export const photoImportFinalizeInput = z.object({
  runId: runShortcode,
  /**
   * The admitted batch these photos belong to; required on every Run with a
   * processor choice (only a legacy Run omits it). New photos are refused
   * once that batch is sealed; replaying already-finalized photos is not.
   */
  clientBatchId: z.uuid().optional(),
  images: z.array(photoImportFinalizeImage).min(1).max(100),
});
export const photoImportFinalizeOutput = z.object({
  finalized: z.array(imageShortcode),
  alreadyFinalized: z.array(imageShortcode),
  submissionId: z.string(),
});

/**
 * The Live Activity a native install started for a Run it created. The
 * per-activity APNs push token is a credential: it is stored for delivery and
 * never returned by any read.
 */
export const apnsEnvironment = z.enum(["development", "production"]);
export type ApnsEnvironment = z.infer<typeof apnsEnvironment>;
/** What a `RunPushRegistration` token is for: an Activity or opt-in alerts. */
export const runPushKind = z.enum(["live_activity", "alert"]);
export type RunPushKind = z.infer<typeof runPushKind>;
/**
 * Which Cubby app build registered a push token, keyed like
 * `APPLE_APP_IDENTITIES`: it names the APNs topic (the build's bundle id), so
 * a token is never addressed to another build's topic.
 */
export const photoRunPushAppIdentity = z.keyof(
  z.object(
    // SAFETY: one entry per APPLE_APP_IDENTITIES key, built from its own keys.
    Object.fromEntries(
      Object.keys(APPLE_APP_IDENTITIES).map((key) => [key, z.unknown()]),
    ) as Record<keyof typeof APPLE_APP_IDENTITIES, z.ZodUnknown>,
  ),
);
export type PhotoRunPushAppIdentity = z.infer<typeof photoRunPushAppIdentity>;
export const photoRunLiveActivityRegisterInput = z.object({
  runId: runShortcode,
  pushToken: z.string().regex(/^[0-9a-f]{16,256}$/),
  apnsEnvironment,
  /** Live Activities exist only in the production app; `development` is refused. */
  appIdentity: photoRunPushAppIdentity,
});
export const photoRunLiveActivityRegisterOutput = z.object({
  registered: z.literal(true),
});
export const photoRunLiveActivityEndInput = z.object({ runId: runShortcode });
export const photoRunLiveActivityEndOutput = z.object({
  ended: z.boolean(),
});

/**
 * Opt-in "notify me when ready" for a Run this install created: the
 * standard APNs device token (not an Activity token). One alert per entry
 * into `needs_attention`, `ready_for_review` or `ready_for_handoff`; the
 * registration stays active across phases and new batches until ended.
 */
export const photoRunNotificationRegisterInput = z.object({
  runId: runShortcode,
  deviceToken: z.string().regex(/^[0-9a-f]{16,256}$/),
  apnsEnvironment,
  appIdentity: photoRunPushAppIdentity,
});
export const photoRunNotificationRegisterOutput = z.object({
  registered: z.literal(true),
});
export const photoRunNotificationEndInput = z.object({ runId: runShortcode });
export const photoRunNotificationEndOutput = z.object({
  ended: z.boolean(),
});

/**
 * `PhotoRunActivityAttributes.ContentState` on the device. Keys are the
 * Swift Codable keys, so the APNs `content-state` decodes without mapping.
 */
export const photoRunLiveActivityContentState = z.object({
  phase: z.enum(["uploading", ...photoRunLifecyclePhase.options]),
  title: z.string(),
  detail: z.string(),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  needsAttention: z.boolean(),
});
export type PhotoRunLiveActivityContentState = z.infer<
  typeof photoRunLiveActivityContentState
>;
