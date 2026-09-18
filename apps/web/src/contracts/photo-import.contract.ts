import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { imageShortcode } from "@cubby/schemas/identifiers";
import { z } from "zod";

import { defineContract, mutation } from "~/contracts/define";

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

const localPhotoAnalysisSchema = z.object({
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
  images: z
    .array(
      z.object({
        clientId: z.string().min(1).max(128),
        imageId: imageShortcode,
        routeId: z.string().min(1),
        source: photoImportSourceSchema,
        destination: photoImportDestinationSchema,
        duplicateDecision: z.enum(["reuse", "keepBoth", "replace"]),
        replaceConfirmed: z.boolean().default(false),
        analysis: localPhotoAnalysisSchema,
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

export const photoImportReceiptSchema = z.object({
  receiptId: z.uuid(),
  idempotencyKey: z.string(),
  committedPhotoIds: z.array(imageShortcode),
  committedClientIds: z.array(z.string()),
  createdDestinations: z.array(
    z.object({
      draftId: z.string(),
      routeId: z.string(),
      id: z.string(),
    }),
  ),
  committedAt: z.iso.datetime(),
});

export type PhotoImportStageInput = z.output<
  typeof photoImportStageInputSchema
>;
export type PhotoImportStageOutput = z.output<
  typeof photoImportStageOutputSchema
>;
export type PhotoImportCommitInput = z.output<
  typeof photoImportCommitInputSchema
>;
export type PhotoImportReceipt = z.output<typeof photoImportReceiptSchema>;

export const photoImportContract = defineContract("photoImport", {
  stage: mutation({
    native: "Manifest photo import staging",
    input: photoImportStageInputSchema,
    output: photoImportStageOutputSchema,
  }),
  commit: mutation({
    native: "Atomic manifest photo import commit",
    input: photoImportCommitInputSchema,
    output: photoImportReceiptSchema,
  }),
});
