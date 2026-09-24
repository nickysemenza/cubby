import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import {
  imageShortcode,
  importRunShortcode,
  productCategoryShortcode,
  productShortcode,
} from "@cubby/schemas/identifiers";
import { ImageStatus, imageAssociationSchema } from "@cubby/schemas/image";
import { imageSightingReportFields } from "@cubby/schemas/image-sighting";
import {
  photoProductCandidatesResponse,
  photoRunReviewResponse,
  reviewPhotoGroupsOutput,
  photoImportCreateRunInput,
  photoImportCreateRunOutput,
  photoImportFinalizeInput,
  photoImportFinalizeOutput,
} from "@cubby/schemas/photo-import-run";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
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
  importRunId: importRunShortcode.optional(),
});

// Keep these as ordinary unions on the native HTTP surface. The OpenAPI pass
// requires every discriminated member to be a named component, while these
// deliberately small variants are private to the enclosing response schema.
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
 * A fresh schema instance every call, deliberately: the OpenAPI generator
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
  idempotencyKey: z.string().min(8).max(200),
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
 * receipt. `idempotencyKey` remains accepted on the input for older clients,
 * but a commit response is never replayed from server-side state.
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

export const photoImportContract = defineContract("photoImport", {
  startGrouping: mutation({
    native: "Start photo grouping after a finalized upload",
    input: z.object({ runId: importRunShortcode }),
    output: z.object({ runId: importRunShortcode, started: z.boolean() }),
  }),
  review: query({
    native: "Review proposed photo groups and processing status in Apple apps",
    input: z.object({ runId: importRunShortcode }),
    output: photoRunReviewResponse,
  }),
  candidates: query({
    native: "Explain possible Product matches for a proposed photo group",
    input: z.object({
      runId: importRunShortcode,
      groupKey: z.string().min(1).max(200),
    }),
    output: photoProductCandidatesResponse,
  }),
  chooseExisting: mutation({
    native: "Select an existing Product for a proposed photo group",
    input: z.object({
      runId: importRunShortcode,
      groupKey: z.string().min(1).max(200),
      productId: productShortcode,
    }),
    output: reviewPhotoGroupsOutput,
  }),
  updateDraft: mutation({
    native: "Correct proposed product identity before approving photos",
    input: z.object({
      runId: importRunShortcode,
      groupKey: z.string().min(1).max(200),
      name: z.string().trim().min(1).max(500),
      categoryId: productCategoryShortcode.nullable().optional(),
      manufacturer: z.string().trim().max(500).nullable().optional(),
      model: z.string().trim().max(500).nullable().optional(),
      notes: z.string().trim().max(5000).nullable().optional(),
    }),
    output: reviewPhotoGroupsOutput,
  }),
  approveGroups: mutation({
    native: "Approve reviewed photo groups in Apple apps",
    input: z.object({
      runId: importRunShortcode,
      groupKeys: z.array(z.string().min(1).max(200)).min(1).max(200),
    }),
    output: reviewPhotoGroupsOutput,
  }),
  discardGroup: mutation({
    native: "Discard a proposed photo group in Apple apps",
    input: z.object({
      runId: importRunShortcode,
      groupKey: z.string().min(1).max(200),
    }),
    output: reviewPhotoGroupsOutput,
  }),
  stage: mutation({
    native: "Manifest photo import staging",
    input: photoImportStageInputSchema,
    output: photoImportStageOutputSchema,
  }),
  commit: mutation({
    native: "Atomic manifest photo import commit",
    input: photoImportCommitInputSchema,
    output: photoImportCommitResultSchema,
  }),
  createRun: mutation({
    native: "Start a photo-inventory import run",
    input: photoImportCreateRunInputSchema,
    output: photoImportCreateRunOutputSchema,
  }),
  finalize: mutation({
    native: "Finalize bulk-uploaded photos into a photo-inventory run",
    input: photoImportFinalizeInputSchema,
    output: photoImportFinalizeOutputSchema,
  }),
  reconcile: mutation({
    native: "Lock-aware photo import reconciliation",
    input: photoImportReconcileInputSchema,
    output: photoImportReconcileOutputSchema,
  }),
});
