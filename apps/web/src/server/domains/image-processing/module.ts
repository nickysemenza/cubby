import {
  storedImageEmbeddedMetadataSchema,
  IMAGE_METADATA_REVISION,
} from "@cubby/schemas/image";
import { imageIdentificationResult } from "@cubby/schemas/image-identification";
import {
  imageProcessingJobKind,
  imageProcessingTerminalResult,
} from "@cubby/schemas/image-processing";
import { z } from "zod";

import { imageProcessingEvent } from "~/server/db/image-processing-schema";
import { imageEvidence } from "~/server/db/retained-tables";
import { defineAsk, defineEvidence } from "~/server/kernel/api";

const imageExecutionInput = z.object({
  receiptId: z.uuid(),
  imageId: z.uuid(),
  sourceContentHash: z.string(),
  processorRevision: z.number(),
  kind: imageProcessingJobKind,
  generation: z.number(),
});
const executionResult = imageProcessingTerminalResult.extend({
  outcome: z.union([
    imageProcessingTerminalResult.shape.outcome,
    z.object({
      kind: z.literal("identify_image"),
      status: z.literal("completed"),
      identification: imageIdentificationResult,
    }),
  ]),
});
export type ImageExecutionResult = z.infer<typeof executionResult>;
export const deviceImageAsk = defineAsk({
  feature: "image.device",
  producer: "image",
  promptVersion: "1",
  input: imageExecutionInput,
  output: executionResult,
  policy: { outputRevision: "1" },
  maxAttempts: 5,
  label: "an Apple image result",
});
export const cloudImageAsk = defineAsk({
  ...deviceImageAsk,
  feature: "image.cloud",
  label: "a cloud image result",
});
export const imageExecutionEvidence = defineEvidence({
  kind: "image.execution",
  table: imageProcessingEvent,
  keys: (row) => [`imageJob:${row.jobId}`],
  discovers: () => [],
});
const metadataAnswer = z.object({
  missing: z.boolean(),
  metadata: storedImageEmbeddedMetadataSchema.nullable(),
});
export const imageMetadataAsk = defineAsk({
  feature: "image.metadata",
  policy: { outputRevision: "1" },
  producer: "image",
  promptVersion: String(IMAGE_METADATA_REVISION),
  input: z.object({
    imageId: z.uuid(),
    key: z.string(),
    contentType: z.string(),
    sourceRevision: z.string(),
  }),
  output: metadataAnswer,
  label: "image metadata",
});
export const imageObservationEvidence = defineEvidence({
  kind: "image.observation",
  table: imageEvidence,
  keys: (row) => [`image:${row.entityId}`],
  discovers: () => [],
});
