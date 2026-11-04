import { z } from "zod";

import { suggestionStatus } from "./ai";
import { assessmentChildHandle } from "./assessment-reference";
import {
  suggestionColumnValue,
  suggestionImpact,
  suggestionListFamily,
  suggestionListRow,
  suggestionRecordRef,
  suggestionStrength,
} from "./suggestion-list";

/** Bump when canonical preparation or the persisted filter operands change. */
export const ASSESSMENT_READ_RULES_VERSION = 1;

/** Serializable form of the canonical family's admitted key, before filtering. */
export const assessmentReadKey = z.object({
  family: suggestionListFamily,
  assessmentId: assessmentChildHandle,
  status: suggestionStatus,
  fingerprint: z.string().nullable(),
  clean: z.boolean(),
  strength: suggestionStrength,
  impact: z.array(suggestionImpact),
  createdAt: z.iso.datetime(),
  columns: z.record(
    z.string(),
    z.union([suggestionColumnValue, z.array(suggestionColumnValue)]),
  ),
  matchedRules: z.array(z.string()),
  automaticRule: z.string().nullable(),
});
export type AssessmentReadKey = z.infer<typeof assessmentReadKey>;

/** The existing declared filter compiler reads these normalized operands. */
export const assessmentReadFilterFacts = z.record(
  z.string(),
  z.union([suggestionColumnValue, z.array(suggestionColumnValue)]),
);
export type AssessmentReadFilterFacts = z.infer<
  typeof assessmentReadFilterFacts
>;

export const assessmentReadFact = z.object({
  key: assessmentReadKey,
  filters: assessmentReadFilterFacts,
  row: suggestionListRow,
});
export type AssessmentReadFact = z.infer<typeof assessmentReadFact>;

/** UUID identity indexes membership; the retained shortcode serves existing clients. */
export const assessmentReadMembership = z.object({
  entity: suggestionRecordRef.shape.entity,
  recordId: z.guid(),
  code: suggestionRecordRef.shape.id,
});
export type AssessmentReadMembership = z.infer<typeof assessmentReadMembership>;

/** Empty facts are a successful ineligible result, never a missing publication. */
export const assessmentReadResult = z.object({
  assessmentId: assessmentChildHandle,
  facts: z.array(assessmentReadFact),
  memberships: z.array(assessmentReadMembership),
  /** Exact canonical competitor identity; non-competing records use their own id. */
  groupKey: z.string().min(1),
});
export type AssessmentReadResult = z.infer<typeof assessmentReadResult>;
