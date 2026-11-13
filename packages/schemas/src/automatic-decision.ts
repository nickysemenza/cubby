import { z } from "zod";
import { suggestionReviewRowSchema } from "./ai";
import { fieldAutomationCause } from "./ai-evaluation";
import {
  suggestionFamily,
  suggestionChildHandle,
  feedbackVerdict,
} from "./suggestion";
import {
  suggestionRecordRef,
  SUGGESTION_RECORD_IDS_MAX,
} from "./suggestion-list";

const automaticDecisionFilters = z.object({
  family: suggestionFamily.optional(),
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
  id: suggestionChildHandle,
  family: suggestionFamily,
  records: z.array(suggestionRecordRef),
  decision: z.json(),
  summary: z.string(),
  applicationVerified: z.boolean(),
  createdAt: z.iso.datetime(),
  fingerprint: z.string().nullable(),
  automaticRule: z.string().nullable(),
  verdict: feedbackVerdict.nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  /** A field decision's record, field, old and new value, for Keep and Wrong, clear it. */
  field: suggestionReviewRowSchema.nullable().optional(),
  /** Why Cubby evaluated the field; absent on decisions made before it was recorded. */
  cause: fieldAutomationCause.nullable().optional(),
  /** Retained for explicit suggestion-review clients; the web audit records feedback only. */
  correction: z
    .object({
      label: z.string(),
      options: z.array(z.object({ label: z.string(), value: z.json() })),
    })
    .nullable(),
});
export const automaticDecisionListOut = z.object({
  items: z.array(automaticDecisionRow),
  totalCount: z.number().int().nonnegative(),
  nextOffset: z.number().int().nullable(),
});
