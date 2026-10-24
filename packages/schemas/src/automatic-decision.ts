import { z } from "zod";
import {
  assessmentFamily,
  assessmentChildHandle,
  feedbackVerdict,
} from "./assessment";
import {
  suggestionRecordRef,
  SUGGESTION_RECORD_IDS_MAX,
} from "./suggestion-list";
import { suggestionCorrectionOutcome } from "./suggestion-correction";

export const automaticDecisionFamily = assessmentFamily.exclude([
  "run_finding",
  "evaluation_sample",
]);

export const automaticDecisionFilters = z.object({
  family: automaticDecisionFamily.optional(),
  recordIds: z
    .array(z.string().min(1))
    .max(SUGGESTION_RECORD_IDS_MAX)
    .optional(),
  reviewStatus: z
    .enum(["all", "unreviewed", "reviewed", "wrong"])
    .default("all"),
});
export const automaticDecisionListInput = automaticDecisionFilters.extend({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(50),
});
export const automaticDecisionRow = z.object({
  id: assessmentChildHandle,
  family: automaticDecisionFamily,
  records: z.array(suggestionRecordRef),
  decision: z.json(),
  summary: z.string(),
  applicationVerified: z.boolean(),
  /** A recorded attempt does not establish that an automatic mutation occurred. */
  correctionAttempt: z
    .object({
      receiptId: assessmentChildHandle,
      sourceFeedbackId: assessmentChildHandle,
      sourceApplicationFeedbackId: assessmentChildHandle,
      createdAt: z.iso.datetime(),
      outcome: suggestionCorrectionOutcome,
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  fingerprint: z.string().nullable(),
  automaticRule: z.string().nullable(),
  verdict: feedbackVerdict.nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  /** Retained for explicit assessment-review clients; the web audit records feedback only. */
  correction: z
    .object({
      label: z.string(),
      options: z.array(z.object({ label: z.string(), value: z.json() })),
    })
    .nullable(),
});
export type AutomaticDecisionRow = z.infer<typeof automaticDecisionRow>;
export const automaticDecisionListOut = z.object({
  items: z.array(automaticDecisionRow),
  totalCount: z.number().int().nonnegative(),
  nextOffset: z.number().int().nullable(),
});
export const suggestionRecordCountsInput = z.object({
  recordIds: z.array(z.string().min(1)).max(SUGGESTION_RECORD_IDS_MAX),
});
export const suggestionRecordCountsOut = z.object({
  records: z.array(
    z.object({ id: z.string(), pending: z.number().int().nonnegative() }),
  ),
});
