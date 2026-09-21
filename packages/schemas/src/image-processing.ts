import { imageRepresentations } from "./image-summary";
import { imageShortcode } from "./identifier-fields";
import { z } from "zod";

/**
 * A derivative belongs to an Image; it is never another gallery attachment.
 * The original Image.url deliberately remains the backwards-compatible source.
 */
export const imageDerivativePurpose = z.enum(["transparent"]);
export type ImageDerivativePurpose = z.infer<typeof imageDerivativePurpose>;

export const imageDerivativeStatus = z.enum([
  "pending",
  "ready",
  "skipped",
  "failed",
  "abandoned",
]);
export type ImageDerivativeStatus = z.infer<typeof imageDerivativeStatus>;

export const imageProcessingJobKind = z.enum([
  "subject_lift",
  "describe_image",
]);
export type ImageProcessingJobKind = z.infer<typeof imageProcessingJobKind>;

export const imageProcessingJobState = z.enum([
  "pending",
  "waiting_for_device",
  "leased",
  "ready",
  "skipped",
  "failed",
]);
export type ImageProcessingJobState = z.infer<typeof imageProcessingJobState>;

export const imageCutoutEligibility = z.enum([
  "eligible",
  "ineligible",
  "review",
]);
export type ImageCutoutEligibility = z.infer<typeof imageCutoutEligibility>;

export const imageDescriptionClaim = z.object({
  text: z.string().trim().min(1).max(1_000),
  evidenceKind: z.enum(["label", "ocr", "visual"]),
  imageId: imageShortcode.optional(),
});
export type ImageDescriptionClaim = z.infer<typeof imageDescriptionClaim>;

/** The portable, provider-neutral analysis result retained for history. */
export const imageDescriptionResult = z.object({
  description: z.string().trim().min(1).max(4_000),
  cutoutEligibility: imageCutoutEligibility,
  claims: z.array(imageDescriptionClaim).max(40),
});
export type ImageDescriptionResult = z.infer<typeof imageDescriptionResult>;

export const IMAGE_DESCRIPTION_PROMPT_REVISION = 1;
export const IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION = 1;
export const IMAGE_PROCESSING_PROTOCOL_VERSION = 1;

const isoDateTime = z.iso.datetime({ offset: true });
const positiveInt = z.int().positive();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);

export const imageProcessingCapabilities = z.object({
  /** True only when the native Vision subject-lift runtime can execute now. */
  visionSubjectLift: z.object({
    available: z.boolean(),
    revision: z.int().positive().optional(),
  }),
  /** Actual-image Foundation Models evaluation, never a text-only surrogate. */
  actualImageDescription: z.object({
    available: z.boolean(),
    revision: z.int().positive().optional(),
  }),
  /** iOS must accurately report foreground-only availability. */
  foreground: z.boolean(),
});
export type ImageProcessingCapabilities = z.infer<
  typeof imageProcessingCapabilities
>;

export const imageProcessingHello = z.object({
  protocolVersion: z.literal(IMAGE_PROCESSING_PROTOCOL_VERSION),
  type: z.literal("hello"),
  deviceId: z.uuid(),
  platform: z.enum(["macos", "ios"]),
  appVersion: z.string().trim().min(1).max(100),
  deviceName: z.string().max(200).optional(),
  osVersion: z.string().max(100).optional(),
  capabilities: imageProcessingCapabilities,
});

export const imageProcessingSource = z.object({
  url: z.url(),
  sha256,
  contentType: z.enum([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ]),
});

const commandBase = z.object({
  jobId: z.uuid(),
  attemptId: z.uuid(),
  deadline: isoDateTime,
  source: imageProcessingSource,
});

export const imageProcessingCommand = z.discriminatedUnion("kind", [
  commandBase.extend({
    kind: z.literal("subject_lift"),
    output: z.object({
      key: z.string().min(1).max(1_000),
      uploadUrl: z.url(),
      contentType: z.literal("image/png"),
    }),
  }),
  commandBase.extend({
    kind: z.literal("describe_image"),
    promptRevision: z.literal(IMAGE_DESCRIPTION_PROMPT_REVISION),
    resultSchemaRevision: z.literal(IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION),
  }),
]);
export type ImageProcessingCommand = z.infer<typeof imageProcessingCommand>;

export const imageProcessingCompletedOutcome = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("subject_lift"),
    status: z.literal("completed"),
    sha256,
    contentType: z.literal("image/png"),
    width: positiveInt,
    height: positiveInt,
  }),
  z.object({
    kind: z.literal("describe_image"),
    status: z.literal("completed"),
    description: imageDescriptionResult,
    runtime: z.object({
      platform: z.enum(["cloud", "macos", "ios"]),
      osVersion: z.string().max(100).optional(),
      model: z.string().max(200).optional(),
    }),
  }),
]);

export const imageProcessingSkippedOutcome = z.object({
  kind: imageProcessingJobKind,
  status: z.literal("skipped"),
  reason: z.enum(["no_subject", "not_suitable", "unsupported_format"]),
});

export const imageProcessingFailedOutcome = z.object({
  kind: imageProcessingJobKind,
  status: z.literal("failed"),
  retryable: z.boolean(),
  reason: z.string().trim().min(1).max(1_000),
});

export const imageProcessingDiagnostics = z.object({
  osVersion: z.string().max(100).optional(),
  appVersion: z.string().max(100).optional(),
  processor: z.string().max(200).optional(),
  decodeMs: z.number().nonnegative().optional(),
  processingMs: z.number().nonnegative().optional(),
  uploadMs: z.number().nonnegative().optional(),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  orientation: z.int().optional(),
});
export const imageProcessingResult = z.object({
  diagnostics: imageProcessingDiagnostics.optional(),
  jobId: z.uuid(),
  attemptId: z.uuid(),
  completedAt: isoDateTime,
  outcome: z.union([
    imageProcessingCompletedOutcome,
    imageProcessingSkippedOutcome,
    imageProcessingFailedOutcome,
  ]),
});
export type ImageProcessingResult = z.infer<typeof imageProcessingResult>;

export const imageProcessingClientMessage = z.discriminatedUnion("type", [
  imageProcessingHello,
  z.object({
    protocolVersion: z.literal(IMAGE_PROCESSING_PROTOCOL_VERSION),
    type: z.literal("result"),
    result: imageProcessingResult,
  }),
]);

export const imageProcessingServerMessage = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: z.literal(IMAGE_PROCESSING_PROTOCOL_VERSION),
    type: z.literal("command"),
    command: imageProcessingCommand,
  }),
  z.object({
    protocolVersion: z.literal(IMAGE_PROCESSING_PROTOCOL_VERSION),
    type: z.literal("acknowledge"),
    jobId: z.uuid(),
    attemptId: z.uuid(),
  }),
]);

// Named wrappers keep the wire unions addressable for OpenAPI/Swift generation.
export const validateImageProcessingCompanionMessageInput = z.object({
  message: imageProcessingClientMessage,
});
export const validateImageProcessingCompanionMessageOutput = z.object({
  message: imageProcessingServerMessage.nullable(),
});

/** Read projection shared by galleries, covers, logos, summaries, and MCP. */
export {
  imageRepresentations,
  type ImageRepresentations,
} from "./image-summary";

export const imageProcessingStatus = z.object({
  cutout: imageDerivativeStatus.nullable(),
  description: imageProcessingJobState.nullable(),
});
export type ImageProcessingStatus = z.infer<typeof imageProcessingStatus>;

/** Immutable model outputs, newest first. Cloud is preferred until policy changes. */
export const imageDescriptionAnalysis = z.object({
  provider: z.string(),
  model: z.string(),
  promptRevision: z.int().positive(),
  resultSchemaRevision: z.int().positive(),
  inputFingerprint: z.string(),
  result: imageDescriptionResult,
  runtime: z.record(z.string(), z.json()).nullable(),
  createdAt: isoDateTime,
  preferred: z.boolean(),
});
export const imageDescriptionCorrection = z.object({
  description: z.string(),
  confirmedAt: isoDateTime,
});

export const imageProcessingStatusInput = z.object({ id: imageShortcode });
export const imageProcessingStatusOutput = z.object({
  representations: imageRepresentations,
  status: imageProcessingStatus,
  analyses: z.array(imageDescriptionAnalysis).max(20),
  correction: imageDescriptionCorrection.nullable(),
});

export const scheduleImageProcessingInput = z.object({
  id: imageShortcode,
  kinds: z
    .array(imageProcessingJobKind)
    .min(1)
    .max(2)
    .default(["subject_lift", "describe_image"]),
});
export const scheduleImageProcessingOutput = z.object({
  jobIds: z.array(z.uuid()),
  submissionId: z.string().optional(),
});

/** Explicit sample evaluation; automatic processing never sends this command. */
export const evaluateAppleImageDescriptionInput = z.object({
  id: imageShortcode,
});
export const evaluateAppleImageDescriptionOutput = z.object({
  jobId: z.uuid().nullable(),
});

export const imageDescriptionCorrectionInput = z.object({
  id: imageShortcode,
  description: z.string().trim().min(1).max(4_000),
});
export const imageDescriptionCorrectionOutput = z.object({
  saved: z.literal(true),
});
