import { workflowRecoveryProgress } from "./workflow-runs";
import { z } from "zod";
import { emailLinkState } from "./email-fields.js";
import {
  emailShortcode,
  purchaseShortcode,
  runShortcode,
} from "./identifier-fields.js";
import {
  EMAIL_RECLASSIFY_LIMIT,
  mailboxClassification,
  mailboxClassificationStage,
} from "./mailbox-research.js";

import { emailClassificationObservationInput } from "./email-observations.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** One Email at the checksum the member reviewed. */
export const emailAtChecksum = z
  .object({ id: emailShortcode, expectedChecksum: sha256 })
  .strict();
export type EmailAtChecksum = z.infer<typeof emailAtChecksum>;

export const EMAIL_IMPORT_LIMIT = 50;
/**
 * An explicit member authorization to import selected Emails, all owned by
 * the member. Search and read results carry each Email's `id` and checksum.
 */
export const emailImportInput = z
  .object({
    items: z
      .array(emailAtChecksum)
      .min(1)
      .max(
        EMAIL_IMPORT_LIMIT,
        `Import at most ${EMAIL_IMPORT_LIMIT} Emails at a time.`,
      ),
  })
  .strict();
export const emailImportOut = z
  .object({ runIds: z.array(runShortcode) })
  .strict();
export type EmailImportInput = z.infer<typeof emailImportInput>;

/**
 * A member's review of one (Email, Purchase) pair. Link records a reviewed
 * link on every order event of the Email that suggests or was decided for the
 * Purchase, replacing another Purchase's link on those events, and marks the
 * Email related. Dismiss records a dismissal on the same events; it cannot
 * undo an import that accepted the Email as the Purchase's source.
 */
export const emailPurchaseDecisionInput = emailAtChecksum
  .extend({
    purchaseId: purchaseShortcode,
    decision: z.enum(["linked", "dismissed"]),
  })
  .strict();
export type EmailPurchaseDecisionInput = z.infer<
  typeof emailPurchaseDecisionInput
>;
export const emailPurchaseDecisionOut = z
  .object({
    id: emailShortcode,
    purchaseId: purchaseShortcode,
    state: emailLinkState,
  })
  .strict();

export const correctEmailRelevanceInput = z
  .object({
    id: emailShortcode,
    expectedChecksum: sha256,
    reviewedChecksum: sha256,
    classification: z.enum(["related", "uncertain"]),
    reason: z.string().trim().min(1),
  })
  .strict();
export const correctEmailRelevanceOut = z
  .object({
    id: emailShortcode,
    checksum: sha256,
    classification: z.enum(["related", "uncertain"]),
    originalAvailable: z.literal(true),
  })
  .strict();
export type CorrectEmailRelevanceInput = z.infer<
  typeof correctEmailRelevanceInput
>;
export type CorrectEmailRelevanceOut = z.infer<typeof correctEmailRelevanceOut>;

export const reclassifyEmailsInput = z
  .object({
    ids: z
      .array(emailShortcode)
      .min(1)
      .max(
        EMAIL_RECLASSIFY_LIMIT,
        `Reclassify at most ${EMAIL_RECLASSIFY_LIMIT} Emails at a time.`,
      ),
  })
  .strict();
/**
 * `replaced` changed the Email's Relevance; `confirmed` kept it and refreshed
 * the deciding stage. The rest only record history: `awaiting_acceptance`
 * would change a completed/researching import or discard retained evidence
 * after an unreadable refetch, `resolution_kept` honors a
 * member's resolution or independent review, `frozen` is an admitted or unresolved historical
 * import source, `changed` means the Email changed during the rerun, and
 * `removed` is deleted or in Spam/Trash at Gmail. `deferred` Emails were not
 * reached within a historical request's time budget. `failed`
 * can occur after publication during read-back; reconcile before retrying.
 */
export const emailReclassifyOutcome = z.enum([
  "replaced",
  "confirmed",
  "awaiting_acceptance",
  "resolution_kept",
  "frozen",
  "removed",
  "changed",
  "deferred",
  "failed",
  "cancelled",
]);
export type EmailReclassifyOutcome = z.infer<typeof emailReclassifyOutcome>;
export const emailReclassifyResult = z
  .object({
    id: emailShortcode,
    outcome: emailReclassifyOutcome,
    /** The rerun's result, whether or not it replaced Relevance. */
    classification: mailboxClassification.nullable(),
    stage: mailboxClassificationStage.nullable(),
    conflict: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();
export const emailReclassifyResults = z.array(emailReclassifyResult);
export type EmailReclassifyResult = z.infer<typeof emailReclassifyResult>;
export const reclassifyEmailsOut = z
  .object({ runIds: z.array(runShortcode) })
  .strict();
export type ReclassifyEmailsInput = z.infer<typeof reclassifyEmailsInput>;
export type ReclassifyEmailsOut = z.infer<typeof reclassifyEmailsOut>;

export const rerunEmailPreviewOut = z
  .object({
    runId: runShortcode,
    status: z.enum(["selected", "abstained"]),
    reason: z.string().nullable(),
  })
  .strict();
export type RerunEmailPreviewOut = z.infer<typeof rerunEmailPreviewOut>;

/** Exact publication receipts; an observation alone cannot establish an outcome. */
export const mailReclassificationCheckpoint = z.strictObject({
  ...workflowRecoveryProgress.shape,
  kind: z.literal("mail_reclassification"),
  version: z.literal(1),
  attempt: z.number().int().nonnegative().optional(),
  complete: z.boolean(),
  results: emailReclassifyResults,
});
export type MailReclassificationCheckpoint = z.infer<
  typeof mailReclassificationCheckpoint
>;
export const mailReclassificationRead = z.strictObject({
  selectedEmails: z.array(
    z.strictObject({ id: emailShortcode.nullable(), checksum: z.string() }),
  ),
  receipts: mailReclassificationCheckpoint.nullable(),
  /** Linked historical or changing-evidence recovery stays navigable after the original Run completes. */
  continuationRuns: z.array(runShortcode),
  /** Historical Run notes may have been truncated; they are not receipts. */
  notes: z.string().nullable(),
  /** Immutable model evidence, not proof that publication succeeded. */
  classificationObservations: z.array(
    emailClassificationObservationInput
      .omit({ emailId: true, runId: true, usageId: true, evaluationId: true })
      .extend({ id: emailShortcode.nullable(), createdAt: z.iso.datetime() }),
  ),
});
