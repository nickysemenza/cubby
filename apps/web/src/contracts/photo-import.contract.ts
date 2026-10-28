import { shortcodeEntities } from "@cubby/schemas/entity-roster";
import { vendorShortcode } from "@cubby/schemas/identifiers";
import {
  imageShortcode,
  ledgerPartyShortcode,
  runShortcode,
  expenseShortcode,
  productCategoryShortcode,
  productShortcode,
} from "@cubby/schemas/identifiers";
import { ImageStatus, imageAssociationSchema } from "@cubby/schemas/image";
import { imageSightingReportFields } from "@cubby/schemas/image-sighting";
import {
  commitPhotoGroupInput,
  commitPhotoGroupOutput,
  listPhotoGroupProposalsInput,
  photoGroupProposalList,
  photoProductCandidateSearchInput,
  photoRunContextImage,
  proposePhotoGroupsInput,
  proposePhotoGroupsOutput,
  photoProductCandidatesResponse,
  photoRunCandidatesResponse,
  photoProductEvidence,
  photoAcceptedSourceLine,
  photoRunReviewResponse,
  photoRunDefaults,
  reviewPhotoGroupsAction,
  reviewPhotoGroupsOutput,
  photoImportCreateRunInput,
  photoImportCreateRunOutput,
  photoImportFinalizeInput,
  photoImportFinalizeOutput,
  photoImportAdmitBatchInput,
  photoImportAdmitBatchOutput,
  photoImportSealBatchInput,
  photoRunLifecycle,
  photoRunLifecycleOutput,
  photoRunSetProcessorInput,
  photoRunExcludeFailedInput,
  photoRunLiveActivityRegisterInput,
  photoRunLiveActivityRegisterOutput,
  photoRunLiveActivityEndInput,
  photoRunLiveActivityEndOutput,
  photoRunNotificationRegisterInput,
  photoRunNotificationRegisterOutput,
  photoRunNotificationEndInput,
  photoRunNotificationEndOutput,
} from "@cubby/schemas/photo-import-run";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Every photo-context page stays in the coordinator's context for the rest of
 * the run, so a page is bounded: 100 photos (the native picker's maximum) stay
 * well inside the photo model's context window.
 */
const PHOTO_CONTEXT_PAGE_MAX = 100;
const perceptualHashSchema = z.string().regex(/^[0-9a-f]{16}$/);

const stagedPhotoSchema = z.object({
  clientId: z.string().min(1).max(128),
  filename: z.string().min(1).max(255),
  contentType: z.enum([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/heic",
    "image/heif",
  ]),
  size: z
    .int()
    .positive()
    .max(50 * 1024 * 1024),
  width: z.int().positive(),
  height: z.int().positive(),
  sha256: sha256Schema,
  perceptualHash: perceptualHashSchema.optional(),
  sourceFingerprint: z
    .object({ hash: perceptualHashSchema, aspectRatio: z.number().positive() })
    .optional(),
  allowExactReuse: z.boolean().default(true),
});

const photoImportStageInputSchema = z.object({
  items: z.array(stagedPhotoSchema).min(1).max(100),
  // Scopes exact-hash reuse detection to one photo-inventory run: re-selecting
  // the same photo within the same run is a no-op rather than a duplicate
  // target, without suppressing reuse detection against images already
  // active from outside the run.
  runId: runShortcode.optional(),
});

// Keep these as ordinary unions on the shared JSON wire. The native model
// generator projects these small variants inline within the response schema.
const photoImportStageItemSchema = z.union([
  z.object({
    kind: z.literal("existing"),
    clientId: z.string(),
    imageId: imageShortcode,
  }),
  z.object({
    kind: z.literal("upload"),
    clientId: z.string(),
    imageId: imageShortcode,
    uploadUrl: z.url(),
    key: z.string(),
    url: z.url(),
  }),
  z.object({
    kind: z.literal("failed"),
    clientId: z.string(),
    retryable: z.literal(true),
  }),
]);

const photoImportStageOutputSchema = z.object({
  items: z.array(photoImportStageItemSchema),
});

const photoImportReconcileInputSchema = z.object({
  imageIds: z.array(imageShortcode).min(1).max(100),
});

const photoImportReconcileOutputSchema = z.object({
  items: z.array(
    z.object({
      imageId: imageShortcode,
      status: ImageStatus,
      associations: z.array(imageAssociationSchema),
    }),
  ),
  missing: z.array(imageShortcode),
});

/**
 * A fresh schema instance every call, deliberately: Swift model generator
 * dedupes an object schema into one shared, positionally-named
 * (`InputSchemaNN`) component the moment the SAME instance appears at two
 * input positions — which would collapse the commit contract's inlined,
 * nicely-aliased `PhotoImportCommitInput.ImagesPayloadPayload.AnalysisPayload`
 * (consumed by hand-written CubbyKit code) into that positional name. Each
 * contract member that embeds this in an input calls the builder again so
 * every usage stays independently inlined and nameable.
 */
export const buildLocalPhotoAnalysisSchema = () =>
  z.object({
    analysisVersion: z.int().positive(),
    analyzedAt: z.iso.datetime(),
    sha256: sha256Schema,
    capturedAt: z.iso.datetime().nullable(),
    contentType: z.string(),
    width: z.int().positive(),
    height: z.int().positive(),
    classifications: z.array(
      z.object({
        identifier: z.string(),
        confidence: z.number().min(0).max(1),
      }),
    ),
    recognizedText: z.array(
      z.object({ text: z.string(), confidence: z.number().min(0).max(1) }),
    ),
    featurePrint: z.object({
      revision: z.string(),
      data: z.string().min(1),
    }),
    provenance: z.object({
      source: z.enum(["camera", "files", "photoLibrary", "serverLazy"]),
      localIdentifier: z.string().nullable(),
      filename: z.string(),
    }),
  });

export const localPhotoAnalysisSchema = buildLocalPhotoAnalysisSchema();

const photoImportDestinationSchema = z.union([
  z.object({ kind: z.literal("existing"), candidateId: z.string().min(1) }),
  z.object({ kind: z.literal("create"), draftId: z.string().min(1).max(128) }),
]);

const photoImportSourceSchema = z.object({
  entity: z.enum(shortcodeEntities),
  id: z.string().min(1),
});

const photoImportCommitInputSchema = z.object({
  // Installation id (`Device.installationId`, NOT a `DEV-` shortcode — the
  // native app always knows the former, and may not yet have registered for
  // the latter). Resolved to a Device row server-side; when absent or
  // unresolvable, no sighting is recorded (`photo-import-commit.service.ts`).
  deviceId: z.string().min(1).max(255).optional(),
  images: z
    .array(
      z.object({
        clientId: z.string().min(1).max(128),
        imageId: imageShortcode,
        routeId: z.string().min(1),
        // Omitted for a `createSelf` route: there is no source record, the created
        // record is its own destination (`photo-import-route.adapter.ts` validates
        // presence is exactly `route.kind !== "createSelf"`).
        source: photoImportSourceSchema.optional(),
        destination: photoImportDestinationSchema,
        duplicateDecision: z.enum(["reuse", "keepBoth", "replace"]),
        replaceConfirmed: z.boolean().default(false),
        analysis: localPhotoAnalysisSchema,
        // A sibling of `analysis`, not nested inside it: `analysesMatch` in
        // `photo-import-commit.service.ts` compares `analysis` by JSON
        // equality across every item that resolves to one image, and
        // per-asset library data (this device's own library identifiers)
        // must not participate in that comparison.
        library: imageSightingReportFields.optional(),
      }),
    )
    .min(1)
    .max(100),
  creates: z
    .array(
      z.object({
        draftId: z.string().min(1).max(128),
        routeId: z.string().min(1),
        capturedAt: z.iso.datetime().nullable(),
        body: z.record(z.string(), z.json()),
      }),
    )
    .max(100),
});

/**
 * The commit response is deliberately an ordinary value, not a persisted
 * receipt: a commit response is never replayed from server-side state.
 */
const photoImportCommitResultSchema = z.object({
  committedPhotoIds: z.array(imageShortcode),
  createdDestinations: z.array(
    z.object({
      draftId: z.string(),
      routeId: z.string(),
      id: z.string(),
    }),
  ),
  committedAt: z.iso.datetime(),
});

const photoImportCreateRunInputSchema = photoImportCreateRunInput;
const photoImportCreateRunOutputSchema = photoImportCreateRunOutput;
const photoImportFinalizeInputSchema = photoImportFinalizeInput;
const photoImportFinalizeOutputSchema = photoImportFinalizeOutput;

export type LocalPhotoAnalysis = z.output<typeof localPhotoAnalysisSchema>;
export type PhotoImportStageInput = z.output<
  typeof photoImportStageInputSchema
>;
export type PhotoImportStageOutput = z.output<
  typeof photoImportStageOutputSchema
>;
export type PhotoImportCommitInput = z.output<
  typeof photoImportCommitInputSchema
>;
export type PhotoImportCommitResult = z.output<
  typeof photoImportCommitResultSchema
>;
export type PhotoImportReconcileInput = z.output<
  typeof photoImportReconcileInputSchema
>;
export type PhotoImportReconcileOutput = z.output<
  typeof photoImportReconcileOutputSchema
>;
export type PhotoImportFinalizeInput = z.output<
  typeof photoImportFinalizeInputSchema
>;
export type PhotoImportFinalizeOutput = z.output<
  typeof photoImportFinalizeOutputSchema
>;

const [saveGroupsAction] = reviewPhotoGroupsAction.options;

export const photoImportContract = defineContract(
  "photoImport",
  {
    startGrouping: mutation({
      exposure: "view",
      note: "The uploader starts grouping after finalize",
      input: z.object({ runId: runShortcode }),
      output: z.object({
        runId: runShortcode,
        started: z.boolean(),
        /** Pending photos whose description is still queued or running; grouping waits for them. */
        waitingForAnalysis: z.number().int().nonnegative(),
      }),
      invalidates: ["runOnly"],
    }),
    review: query({
      exposure: "view",
      note: "Agents read proposals through photo_run_read.proposals",
      input: z.object({ runId: runShortcode }),
      output: photoRunReviewResponse,
      cache: { tags: [["run"]] },
    }),
    candidates: query({
      exposure: "view",
      note: "Agents read candidates through photo_run_read.product_candidates",
      input: z.object({
        runId: runShortcode,
        groupKey: z.string().min(1).max(200),
      }),
      output: photoProductCandidatesResponse,
      cache: {
        tags: [
          ["run"],
          ["product"],
          ["inventory"],
          ["expense"],
          ["purchase"],
          ["image"],
        ],
      },
    }),
    candidatesBatch: query({
      exposure: "view",
      note: "Agents can read individual photo candidates",
      input: z.object({
        runId: runShortcode,
        /** Partition large Runs across Worker invocations; omitted reads every group. */
        groupKeys: z.array(z.string().min(1).max(200)).max(6).optional(),
      }),
      output: photoRunCandidatesResponse,
      cache: {
        tags: [
          ["recommendations"],
          ["product"],
          ["inventory"],
          ["expense"],
          ["purchase"],
          ["image"],
        ],
      },
    }),
    productEvidence: query({
      exposure: "view",
      input: z.object({ runId: runShortcode, productId: productShortcode }),
      output: photoProductEvidence,
      cache: {
        tags: [
          ["product"],
          ["inventory"],
          ["expense"],
          ["purchase"],
          ["image"],
        ],
      },
    }),
    rejectCandidate: mutation({
      description:
        "Record the member's Not this one verdict for a candidate Product. Suppression follows the group's photos through combine/split; supply a stable operationId.",
      input: z.object({
        runId: runShortcode,
        groupKey: z.string().min(1).max(200),
        productId: productShortcode,
        operationId: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "Caller-generated retry key for this candidate rejection, not an entity reference. Reuse it only for an identical decision.",
          ),
      }),
      output: reviewPhotoGroupsOutput,
      invalidates: ["runOnly", "recommendations"],
    }),
    linkableExpenses: query({
      exposure: "view",
      input: z.object({
        runId: runShortcode,
        groupKey: z.string().min(1).max(200),
        search: z.string().trim().max(200).optional(),
      }),
      output: z.object({
        productId: productShortcode,
        productName: z.string(),
        lines: z.array(
          z.object({
            expenseId: expenseShortcode,
            name: z.string(),
            date: z.string().nullable(),
            cost: z.number().nullable(),
            productQuantity: z.number().nullable(),
            purchaseId: z.string().nullable(),
            purchaseLabel: z.string().nullable(),
            expectedQuantityDelta: z.number().nullable(),
            acceptedSourceLines: z.array(photoAcceptedSourceLine),
          }),
        ),
      }),
      cache: { tags: [["run"]] },
    }),
    chooseExisting: mutation({
      description: "Point one proposed group at an existing productId.",
      input: z.object({
        runId: runShortcode,
        groupKey: z.string().min(1).max(200),
        productId: productShortcode,
      }),
      output: reviewPhotoGroupsOutput,
    }),
    resolveConcern: mutation({
      description:
        "Explicitly resolve the agent's original identity concern, preserving it with member/time and an optional reply. Product edits never resolve a concern.",
      input: z.object({
        runId: runShortcode,
        groupKey: z.string().min(1).max(200),
        reply: z
          .string()
          .trim()
          .max(500)
          .regex(/^[^\r\n]*$/, "Use a one-line reply")
          .optional(),
        expectedRevision: z.iso.datetime().optional(),
      }),
      output: reviewPhotoGroupsOutput,
      invalidates: ["runOnly"],
    }),
    updateDraft: mutation({
      description:
        "Correct one proposed group's new-Product identity before approval.",
      nativeModels: { input: "json" },
      input: z.object({
        runId: runShortcode,
        groupKey: z.string().min(1).max(200),
        name: z.string().trim().min(1).max(500),
        categoryId: productCategoryShortcode.nullable().optional(),
        brandId: vendorShortcode.nullable().optional(),
        model: z.string().trim().max(500).nullable().optional(),
        notes: z.string().trim().max(5000).nullable().optional(),
      }),
      output: reviewPhotoGroupsOutput,
    }),
    approveGroups: mutation({
      description:
        "Approve proposed groups (all when groupKeys is omitted), committing each as commit_group would; expectedRevisions refuses groups changed since review. Only on the member's instruction.",
      command: { label: "Approve photo groups", confirmation: null },
      input: z.object({
        runId: runShortcode,
        /** Omit to approve every `proposed` group. */
        groupKeys: z
          .array(z.string().min(1).max(200))
          .min(1)
          .max(200)
          .optional(),
        expectedRevisions: z
          .array(
            z.object({
              groupKey: z.string().min(1),
              updatedAt: z.iso.datetime(),
            }),
          )
          .max(200)
          .optional(),
      }),
      output: reviewPhotoGroupsOutput,
      invalidates: ["runOnly", "product", "inventory"],
    }),
    discardGroup: mutation({
      description: "Discard one proposed group.",
      command: { label: "Discard photo group", confirmation: null },
      input: z.object({
        runId: runShortcode,
        groupKey: z.string().min(1).max(200),
      }),
      output: reviewPhotoGroupsOutput,
      invalidates: ["runOnly"],
    }),
    saveGroups: mutation({
      description: "Save the run page's reviewed group edits in one call.",
      command: { label: "Save photo group edits", confirmation: null },
      input: saveGroupsAction
        .omit({ action: true })
        .extend({ runId: runShortcode }),
      output: reviewPhotoGroupsOutput,
      invalidates: ["runOnly"],
    }),
    stage: mutation({
      exposure: "view",
      note: "Native manifest import",
      input: photoImportStageInputSchema,
      output: photoImportStageOutputSchema,
    }),
    commit: mutation({
      exposure: "view",
      note: "Native manifest import",
      input: photoImportCommitInputSchema,
      output: photoImportCommitResultSchema,
    }),
    createRun: mutation({
      exposure: "view",
      input: photoImportCreateRunInputSchema,
      output: photoImportCreateRunOutputSchema,
    }),
    admitBatch: mutation({
      exposure: "view",
      input: photoImportAdmitBatchInput,
      output: photoImportAdmitBatchOutput,
      invalidates: ["runOnly"],
    }),
    sealBatch: mutation({
      exposure: "view",
      command: {
        label: "Finish with uploaded photos",
        confirmation: null,
        success: "Upload batches closed; uploaded photos retained",
      },
      input: photoImportSealBatchInput,
      output: photoRunLifecycleOutput,
      invalidates: ["runOnly"],
    }),
    setDefaults: mutation({
      exposure: "view",
      command: { label: "Set photo import defaults", confirmation: null },
      input: z.object({ runId: runShortcode, defaults: photoRunDefaults }),
      output: photoRunReviewResponse,
      invalidates: ["runOnly"],
    }),
    setProcessor: mutation({
      exposure: "view",
      input: photoRunSetProcessorInput,
      output: photoRunLifecycle,
      invalidates: ["runOnly"],
    }),
    excludeFailed: mutation({
      exposure: "view",
      command: {
        label: "Continue without failed photos",
        confirmation: null,
        success: "Failed photos skipped; originals retained",
      },
      input: photoRunExcludeFailedInput,
      output: photoRunLifecycle,
      invalidates: ["runOnly"],
    }),
    registerLiveActivity: mutation({
      exposure: "view",
      input: photoRunLiveActivityRegisterInput,
      output: photoRunLiveActivityRegisterOutput,
    }),
    endLiveActivity: mutation({
      exposure: "view",
      input: photoRunLiveActivityEndInput,
      output: photoRunLiveActivityEndOutput,
    }),
    registerNotification: mutation({
      exposure: "view",
      input: photoRunNotificationRegisterInput,
      output: photoRunNotificationRegisterOutput,
    }),
    endNotification: mutation({
      exposure: "view",
      input: photoRunNotificationEndInput,
      output: photoRunNotificationEndOutput,
    }),
    finalize: mutation({
      exposure: "view",
      input: photoImportFinalizeInputSchema,
      output: photoImportFinalizeOutputSchema,
    }),
    reconcile: mutation({
      exposure: "view",
      input: photoImportReconcileInputSchema,
      output: photoImportReconcileOutputSchema,
    }),
    // Agent-facing (MCP `photo_run`, `photo_run_read`): the photo agent's reads
    // and bounded writers.
    /** One bounded page of a run's photos in capture order, with owner and notes. */
    runContext: query({
      description:
        "One photo-inventory run's owner, notes, and one page of its photos in capture order (undated photos last) with their capture time, cloud descriptions and recognized text. Pass `nextCursor` back as `cursor` until it is null; an item photographed across a page boundary continues on the next page. Set `withImageUrls` only if you can open images. Read this before proposing groups.",
      input: z.object({
        runId: runShortcode,
        cursor: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(PHOTO_CONTEXT_PAGE_MAX).optional(),
        withImageUrls: z.boolean().optional(),
      }),
      output: z.object({
        runId: runShortcode,
        ledgerPartyId: ledgerPartyShortcode,
        notes: z.string().nullable(),
        defaults: photoRunDefaults.nullish(),
        totalImages: z.number().int().nonnegative(),
        nextCursor: z.number().int().nonnegative().nullable(),
        images: z.array(photoRunContextImage),
      }),
    }),
    productCandidates: query({
      description:
        "Existing Products for a photo group, before proposing a new one: name/variant candidates and whether each has a purchase, own photo, earlier photo import, or inventory. Compare exact size and color yourself; the rank is not proof and human approval is required to attach photos.",
      input: photoProductCandidateSearchInput,
      output: photoProductCandidatesResponse,
    }),
    proposals: query({
      description:
        "A photo-inventory run's proposed, committed and discarded item groups, including any name-collision `conflict` or `lastError` from a failed approval, and the pending images no proposed group mentions yet.",
      input: listPhotoGroupProposalsInput,
      output: photoGroupProposalList,
    }),
    /** Upsert proposed groups for human review; writes no Product or Inventory. */
    proposeGroups: mutation({
      description:
        "Propose how a run's images group into items, for a human to review and approve on the run page — nothing is written to Products or Inventory until approval, which runs photo_run.commit_group with each group's payload. Each group has commit_group's shape (minus runId) plus optional `evidence` (why these photos are one item, and why this Product). Upserts by groupKey: a still-`proposed` group is replaced; a `committed` or `discarded` groupKey is left untouched and returned in `frozenGroupKeys`. `removeGroupKeys` drops proposed groups. Every image must be a `pending` target of the run and, across the run's proposed groups after this call, appear in exactly one group (attached or skipped) — otherwise the whole call is refused. Returns every proposal plus the pending images no group mentions yet.",
      input: proposePhotoGroupsInput,
      output: proposePhotoGroupsOutput,
      invalidates: ["runOnly"],
    }),
    /** The bounded writer approval runs; idempotent per (runId, groupKey). */
    commitGroup: mutation({
      description:
        'The bounded writer approval runs. Product/Inventory writes require explicit review with observedName, stockIntent and a null unresolvedReason; skip-only groups need no review. Prefer photo_run.propose_groups and let the user approve on the run page; call this only when the user explicitly asks to skip review. Turns one group of already-staged images into one Product (an existing Product by id, or a genuinely new one) with each image attached under an `item` or `label` purpose, and optionally one Inventory entry. Idempotent per (runId, groupKey): the exact same call replays the prior result; a changed payload under the same groupKey is refused unless the earlier attempt failed. When a `create` name or alias exactly (case-insensitively) matches a live Product, nothing is written and the call returns `outcome: "conflict"` with the colliding Product ids — never a speculative new Product. Every listed image must be a `pending` target of the run and appear in exactly one of `images` (attach) or `skip` (with a reason); a skip-only group touches no Product. Marks the run `completed` once no `pending` target remains.',
      input: commitPhotoGroupInput,
      output: commitPhotoGroupOutput,
      invalidates: ["runOnly", "product", "inventory"],
    }),
  },
  { exposure: "capability", mcpToolGroup: "photo_run" },
);
