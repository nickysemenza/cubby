import { z } from "zod";
import { imageShortcode } from "./identifiers";
import { imageDescriptionAnalysis } from "./image-processing";

export const activityRunId = z.string().regex(/^(?:IPR|RUN)-[A-Z0-9]+$/u);
export const activitySubmissionId = z.string().regex(/^IPS-[A-Z0-9]+$/u);
export const activityKind = z.enum([
  "purchase_import",
  "purchase_validation",
  "product_enrichment",
  "photo_inventory",
  "describe_image",
  "subject_lift",
]);
export const activityExecutor = z.object({
  kind: z.enum(["cloud", "device"]),
  deviceId: z.uuid().nullable(),
  name: z.string().max(200),
  platform: z.enum(["cloud", "macos", "ios"]),
  appVersion: z.string().max(100).nullable(),
  osVersion: z.string().max(100).nullable(),
});
export type ActivityExecutor = z.infer<typeof activityExecutor>;
export const activityRun = z.object({
  id: activityRunId,
  kind: activityKind,
  subjectId: z.string().nullable(),
  subjectName: z.string(),
  subjectHref: z.string().nullable(),
  state: z.string(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  attempts: z.int().nonnegative(),
  executors: z.array(activityExecutor),
  estimatedCost: z.number().nullable(),
  error: z.string().nullable(),
  hasDiagnostics: z.boolean(),
  canRetry: z.boolean(),
});
export type ActivityRun = z.infer<typeof activityRun>;
export const activityListInput = z.object({
  kind: activityKind.optional(),
  state: z.string().max(50).optional(),
  subjectId: z.string().max(100).optional(),
  submissionId: activitySubmissionId.optional(),
  executor: z.enum(["all", "cloud", "device", "unknown"]).default("all"),
  deviceId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
  cursor: z.string().max(500).optional(),
  limit: z.int().min(1).max(100).default(20),
});
export type ActivityListInput = z.infer<typeof activityListInput>;
export const activityListOutput = z.object({
  items: z.array(activityRun),
  total: z.int().nonnegative(),
  nextCursor: z.string().nullable(),
});
export const activityDetailInput = z.object({ id: activityRunId });
export const activityAttempt = z.object({
  number: z.int().positive(),
  state: z.string(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  executor: activityExecutor.nullable(),
  diagnosticsJson: z.string().nullable(),
  resultJson: z.string().nullable(),
  error: z.string().nullable(),
});
export const activityDetailOutput = z.object({
  run: activityRun,
  attempts: z.array(activityAttempt),
  nextAttemptCursor: z.string().nullable(),
});
export const activityAttemptInput = activityDetailInput.extend({
  cursor: z.string().max(500).optional(),
  limit: z.int().min(1).max(100).default(20),
});
export const activityEvent = z.object({
  id: z.string(),
  occurredAt: z.iso.datetime(),
  source: z.enum(["server", "cloud", "device"]),
  event: z.string(),
  level: z.enum(["info", "error", "debug"]),
  attempt: z.int().nullable(),
  detailsJson: z.string().nullable(),
});
export const activityEventsOutput = z.object({
  items: z.array(activityEvent),
  nextCursor: z.string().nullable(),
});
export const activityDevicesOutput = z.object({
  items: z.array(activityExecutor),
});
export const activitySubmissionInput = z.object({ id: activitySubmissionId });
export const activitySubmissionOutput = z.object({
  id: activitySubmissionId,
  createdAt: z.iso.datetime(),
  total: z.int(),
  newlyQueued: z.int(),
  reused: z.int(),
  alreadyRunning: z.int(),
  completed: z.int(),
  skipped: z.int(),
  failed: z.int(),
  remaining: z.int(),
  estimatedCost: z.number().nullable(),
});
export const imageAnalysisHistoryInput = z.object({
  id: imageShortcode,
  cursor: z.string().max(500).optional(),
  limit: z.int().min(1).max(100).default(20),
});
export const imageAnalysisHistoryOutput = z.object({
  items: z.array(imageDescriptionAnalysis),
  unparsed: z
    .array(
      z.object({
        provider: z.string().nullable(),
        model: z.string().nullable(),
        promptVersion: z.string(),
        resultSchemaRevision: z.int().nullable(),
        createdAt: z.iso.datetime(),
        rawResultJson: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
  nextCursor: z.string().nullable(),
  total: z.int().nonnegative(),
});
export const retryImageProcessingInput = z.object({ id: imageShortcode });
export const retryImageProcessingOutput = z.object({
  retried: z.int().nonnegative(),
  submissionId: activitySubmissionId.nullable(),
});
