import { z } from "zod";
import { dataQuality } from "./data-quality";
import { parseShortcode } from "@cubby/shared";
import { imageShortcode, runEntityId } from "./identifiers";
import { entitySchema, type Entity } from "./entity";
import { imageDescriptionAnalysis } from "./image-processing";
import { imageUrlSummary } from "./image-summary";
import { runTrigger } from "./run-fields";
import { activityKind, type ActivityKind } from "./activity-fields";
export { ACTIVITY_KIND_LABEL, activityKind } from "./activity-fields";
export type { ActivityKind } from "./activity-fields";

export const activityRunId = z.string().regex(/^(?:IPR|RUN)-[A-Z0-9]+$/u);
export const activitySubmissionId = z.string().regex(/^IPS-[A-Z0-9]+$/u);
const activityIconFallback = {
  account_sync: "vendor",
  mail_import: "purchase",
  purchase_validation: "purchase",
  product_enrichment: "product",
  photo_inventory: "inventory",
  ai_suggest: "run",
  suggestion_sweep: "run",
  background: "run",
  file_import: "purchase",
  mail_search: "vendorAccount",
  mail_discovery: "vendorAccount",
  subject_lift: "image",
  describe_image: "image",
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
export const activityRun = z.object({
  id: activityRunId,
  recordType: z.enum(["run", "image_job"]),
  parentRunId: z
    .string()
    .regex(/^RUN-[A-Z0-9]+$/u)
    .nullable(),
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
  estimatedCost: z.number().nullable(),
  error: z.string().nullable(),
  hasDiagnostics: z.boolean(),
  canRetry: z.boolean(),
});
export type ActivityRun = z.infer<typeof activityRun>;
export const activityListInput = z.object({
  recordType: z.enum(["run", "image_job"]).optional(),
  parentRunId: z
    .string()
    .regex(/^RUN-[A-Z0-9]+$/u)
    .optional(),
  kind: activityKind.optional(),
  trigger: runTrigger.optional(),
  /**
   * Hide runs started by these triggers (the list's default hides
   * `ephemeral`). Image jobs with no parent run have no trigger and stay.
   */
  excludeTriggers: z.array(runTrigger).optional(),
  /**
   * `false` hides routine runs (scheduled passes that completed without
   * finding anything; the list's default), `true` shows only them. Image jobs
   * are never routine.
   */
  routine: z.boolean().optional(),
  vendorAccountId: z.string().optional(),
  vendorId: z.string().optional(),
  ledgerPartyId: z.string().optional(),
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
export const activityWorkCounts = z.object({
  working: z.int().nonnegative(),
  waiting: z.int().nonnegative(),
  needsReview: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  completed: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
});

export const activityListOutput = z.object({
  /** Matching attempts across all pages, not verified records or mailbox coverage. */
  workCounts: activityWorkCounts,
  workSummary: z.string(),
  items: z.array(activityRun),
  total: z.int().nonnegative(),
  nextCursor: z.string().nullable(),
});
export const activityGroupsOutput = z.object({
  /** Matching attempts across all groups, independent of cursor position. */
  workCounts: activityWorkCounts,
  workSummary: z.string(),
  items: z.array(
    z.object({
      root: activityRun,
      /** Group liveness includes descendants, independently of the root's state. */
      active: z.boolean(),
      /** Matching work in this group; completed attempts do not imply verified facts. */
      workCounts: activityWorkCounts,
      workSummary: z.string(),
      childCount: z.int().nonnegative(),
      contextOnly: z.boolean(),
      latestAt: z.iso.datetime(),
    }),
  ),
  total: z.int().nonnegative(),
  totalItems: z.int().nonnegative(),
  nextCursor: z.string().nullable(),
});
export const activityGroupChildrenInput = activityListInput.extend({
  rootId: z.string().regex(/^RUN-[A-Z0-9]+$/u),
});

/** Attempt states across matching related work, separate from target verification. */
export function activityWorkSummary(
  counts: z.infer<typeof activityWorkCounts>,
): string {
  return [
    counts.working ? `${counts.working} working` : null,
    counts.waiting ? `${counts.waiting} waiting` : null,
    counts.needsReview ? `${counts.needsReview} need review` : null,
    counts.failed ? `${counts.failed} failed` : null,
    counts.skipped ? `${counts.skipped} skipped` : null,
    counts.completed ? `${counts.completed} completed` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
export const activityDetailInput = z.object({
  id: z
    .string()
    .refine(
      (value) =>
        activityRunId.safeParse(value).success ||
        runEntityId.safeParse(value).success,
      "Expected an activity shortcode or Run UUID",
    )
    .describe(
      "Activity shortcode or internal Run UUID; responses retain the canonical public shortcode",
    ),
});
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
