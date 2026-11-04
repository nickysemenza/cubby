import { z } from "zod";

import { suggestionStatus } from "./ai";
import { assessmentChildHandle } from "./assessment-reference";
import { assessmentFamily } from "./assessment";
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
export const ASSESSMENT_READ_TARGET = "assessment.reviewFacts";

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

const membershipToken = z.object({
  entity: suggestionRecordRef.shape.entity,
  stateFamily: assessmentFamily,
});
/** Discovery compares raw text; counts use the separately resolved reference view. */
export const assessmentReadMembership = z.discriminatedUnion("kind", [
  membershipToken.extend({
    kind: z.literal("scope"),
    value: z.string(),
    /** Retained recommendation record matching historically ignores a recordEntity mismatch. */
    retained: z.boolean(),
  }),
  membershipToken.extend({
    kind: z.literal("ref"),
    value: suggestionRecordRef.shape.id,
    retained: z.literal(false),
  }),
]);
export type AssessmentReadMembership = z.infer<typeof assessmentReadMembership>;

/** Retained for open proposals even when their current result is ineligible. */
export const assessmentReadDependency = z.object({
  sourceKind: z.string().min(1),
  sourceId: z.guid(),
});
export type AssessmentReadDependency = z.infer<typeof assessmentReadDependency>;

/**
 * `sourceKind` for an input no single Entity row represents; `sourceId` is the
 * subject record. Dotted values cannot equal an Entity name, so publication's
 * Entity join skips them. Each one's capture selector is its own obligation.
 */
export const assessmentReadScopedSourceKind = z.enum({
  fieldWrite: "assessment.fieldWrite",
  productClassification: "assessment.productClassification",
});

/** An exact observed ticket, not a sequence-number watermark or an authority. */
export const assessmentReadObservedTicket = z.object({
  target: z.string().min(1),
  ref: assessmentChildHandle,
  ticket: z.number().int().nonnegative(),
});
export type AssessmentReadObservedTicket = z.infer<
  typeof assessmentReadObservedTicket
>;

export const assessmentReadGroupKeys = z.array(z.string().min(1)).min(1);
export type AssessmentReadGroupKeys = z.infer<typeof assessmentReadGroupKeys>;

/** Empty facts are a successful ineligible result, never a missing publication. */
export const assessmentReadResult = z.object({
  assessmentId: assessmentChildHandle,
  facts: z.array(assessmentReadFact),
  memberships: z.array(assessmentReadMembership),
  dependencies: z.array(assessmentReadDependency),
  /** Exact canonical competitor identity; non-competing records use their own id. */
  groupKey: z.string().min(1),
});
export type AssessmentReadResult = z.infer<typeof assessmentReadResult>;
