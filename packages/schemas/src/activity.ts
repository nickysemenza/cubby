import { aiCostSummaryFields } from "./ai-cost";
import { z } from "zod";
import { dataQuality } from "./data-quality";
import { parseShortcode } from "@cubby/shared";
import { imageShortcode, runShortcode } from "./identifiers";
import { entitySchema, type Entity } from "./entity";
import { imageDescriptionAnalysis } from "./image-processing";
import { imageUrlSummary } from "./image-summary";
import { runTrigger } from "./run-fields";
import { activityKind, type ActivityKind } from "./activity-fields";
export { ACTIVITY_KIND_LABEL, imageProcessingJobKind } from "./activity-fields";
export type { ActivityKind } from "./activity-fields";

const activityRunId = z.string().regex(/^(?:IPR|RUN)-[A-Z0-9]+$/u);
export const activitySubmissionId = z.string().regex(/^IPS-[A-Z0-9]+$/u);
const activityIconFallback = {
  account_sync: "vendor",
  mail_import: "purchase",
  purchase_validation: "purchase",
  product_enrichment: "product",
  photo_inventory: "inventory",
  ai_suggest: "run",
  ai_refresh: "run",
  background: "run",
  file_import: "purchase",
  mail_search: "vendorAccount",
  mail_discovery: "vendorAccount",
  mail_reclassify: "run",
  connection_discovery: "run",
  maintenance: "run",
  derived_refresh: "run",
  sweep: "run",
  subject_lift: "image",
  describe_image: "image",
  identify_image: "image",
} satisfies Record<ActivityKind, Entity>;

/** Identity stays independent of run status and execution device. */
export function activityIconEntity(input: {
  kind: ActivityKind;
  subjectId?: string | null;
  ledgerPartyId?: string | null;
}): Entity {
  const subjectId =
    input.subjectId ??
    (input.kind === "ai_suggest" || input.kind === "background"
      ? input.ledgerPartyId
      : null);
  const subject = subjectId ? parseShortcode(subjectId) : null;
  const entity = entitySchema.safeParse(subject?.type);
  return entity.success ? entity.data : activityIconFallback[input.kind];
}
export const activityExecutor = z.object({
  kind: z.enum(["cloud", "device"]),
  deviceId: z.uuid().nullable(),
  name: z.string().max(200),
  platform: z.enum(["cloud", "macos", "ios"]),
  appVersion: z.string().max(100).nullable(),
  osVersion: z.string().max(100).nullable(),
});
export type ActivityExecutor = z.infer<typeof activityExecutor>;
const activityRun = z.object({
  id: activityRunId,
  recordType: z.enum(["run", "image_job"]),
  parentRunId: runShortcode.nullable(),
  kind: activityKind,
  trigger: runTrigger.nullable(),
  vendorAccountId: z.string().nullable(),
  vendorId: z.string().nullable(),
  ledgerPartyId: z.string().nullable(),
  subjectId: z.string().nullable(),
  subjectName: z.string(),
  iconEntity: entitySchema,
  /** Shared Run quality; image-processing jobs are not scored entities. */
  dataQuality: dataQuality.nullable(),
  /** The subject's cover (a vendor's logo, an image job's own image). */
  subjectImage: imageUrlSummary.nullable(),
  /** What the run does, e.g. "Order mail import" for a mail-pass account sync. */
  workLabel: z.string(),
  /** The latest progress line an active or finished run reported. */
  currentStep: z.string().nullable(),
  /** Target outcomes; null for image jobs, which have no targets. */
  targetCounts: z
    .object({
      total: z.int().nonnegative(),
      completed: z.int().nonnegative(),
      skipped: z.int().nonnegative(),
      blocked: z.int().nonnegative(),
      pending: z.int().nonnegative(),
    })
    .nullable(),
  /** `targetCounts` as one line: "3/5 done · 1 skipped · 1 blocked". */
  targetSummary: z.string().nullable(),
  /** The first few targets in work order, named and pictured for the row. */
  targetPreview: z.array(
    z.object({
      entity: entitySchema,
      id: z.string(),
      name: z.string().nullable(),
      state: z.string(),
      displayImage: imageUrlSummary.nullable(),
    }),
  ),
  /** Distinct records this run's writes touched (its AuditLog rows). */
  changedCount: z.int().nonnegative(),
  state: z.string(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  attempts: z.int().nonnegative(),
  executors: z.array(activityExecutor),
  ...aiCostSummaryFields,
  error: z.string().nullable(),
  hasDiagnostics: z.boolean(),
  canRetry: z.boolean(),
});
export type ActivityRun = z.infer<typeof activityRun>;

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

/** One line for every client; null when the run has no targets. */
export function targetOutcomeSummary(
  counts: ActivityRun["targetCounts"],
): string | null {
  if (!counts || counts.total === 0) return null;
  return [
    `${counts.completed}/${counts.total} done`,
    counts.skipped ? `${counts.skipped} skipped` : null,
    counts.blocked ? `${counts.blocked} blocked` : null,
    counts.pending ? `${counts.pending} to go` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
