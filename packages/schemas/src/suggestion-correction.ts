import { z } from "zod";
import { suggestionAcceptanceReceipt } from "./ai-evaluation";

import {
  assessmentChildHandle,
  assessmentFamily,
  assessmentSubject,
} from "./assessment";

export const correctionAuthorityReceiptKinds = z.enum([
  "assessment_application",
  "saved_field",
]);
export const CORRECTION_OUTCOME_RECEIPT_KIND = "assessment_correction";

/** A correction is reusable authority only after its member application committed. */
export const suggestionCorrectionSource = z.object({
  feedbackId: assessmentChildHandle,
  assessmentId: assessmentChildHandle,
  family: assessmentFamily,
  subject: assessmentSubject,
  judgment: z.json(),
  evidence: z.json().nullable(),
  correctedValue: z.json(),
  actorUserId: z.string().min(1),
  applicationFeedbackId: assessmentChildHandle,
  applicationReceipt: z.json(),
  /** Exact audited field application; never reconstructed from a mutable projection. */
  fieldApplicationReceipt: suggestionAcceptanceReceipt.nullable().default(null),
});

export const suggestionCorrectionTarget = z.object({
  assessmentId: assessmentChildHandle,
  family: assessmentFamily,
  subject: assessmentSubject,
  judgment: z.json(),
  evidence: z.json().nullable(),
  fingerprint: z.string().nullable(),
  status: z.string(),
  applicationReceipt: z.json().nullable(),
  applicationFeedbackId: assessmentChildHandle.nullable(),
});

/** Every domain plan keeps the originating authority and original application lineage. */
export const suggestionCorrectionPlan = z.object({
  source: suggestionCorrectionSource,
  target: suggestionCorrectionTarget,
});

export const suggestionCorrectionOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), receipt: z.json() }),
  z.object({ status: z.literal("unchanged"), receipt: z.json() }),
  z.object({ status: z.literal("held"), reason: z.string().min(1) }),
]);

export type SuggestionCorrectionSource = z.infer<
  typeof suggestionCorrectionSource
>;
export type SuggestionCorrectionTarget = z.infer<
  typeof suggestionCorrectionTarget
>;
export type SuggestionCorrectionPlan = z.infer<typeof suggestionCorrectionPlan>;
export type SuggestionCorrectionOutcome = z.infer<
  typeof suggestionCorrectionOutcome
>;
