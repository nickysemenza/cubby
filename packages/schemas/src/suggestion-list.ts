import { z } from "zod";

import { suggestionReviewRowSchema, suggestionStatus } from "./ai";
import { assessmentChildHandle } from "./assessment-reference";
import { dataCheck } from "./data-quality";
import { connectionProposal, connectionRelation } from "./entity-connections";
import { shortcodeEntities } from "./entity-manifest";
import { anyShortcodeSchema, nonEmptyTuple } from "./identifier-fields";
import { runShortcode } from "./identifiers";
import {
  statementSuggestionFilters,
  statementSuggestionGroupOut,
  statementSuggestionOut,
} from "./statement-suggestion";

/** Assessment families the Suggestions page lists. */
export const suggestionListFamily = z.enum([
  "field",
  "statement_transaction",
  "recommendation",
]);
export type SuggestionListFamily = z.infer<typeof suggestionListFamily>;

/** How well a Suggestion's own evidence supports it, judged by its family. */
export const suggestionStrength = z.enum(["strong", "medium", "weak"]);
export type SuggestionStrength = z.infer<typeof suggestionStrength>;

/**
 * `ready`: clean first, then strength, then newest. `impact`: most
 * data-quality checks restored first, then `ready`. `newest`: creation time.
 */
export const suggestionSort = z.enum(["ready", "impact", "newest"]);
export type SuggestionSort = z.infer<typeof suggestionSort>;

const shortcodeEntity = z.enum(shortcodeEntities);
export const suggestionRecordRef = z.object({
  entity: shortcodeEntity,
  id: anyShortcodeSchema(nonEmptyTuple(shortcodeEntities)),
  name: z.string().nullable(),
});
export type SuggestionRecordRef = z.infer<typeof suggestionRecordRef>;

/** Structured summary parts; clients render each part with its own control. */
export const suggestionSummaryPart = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("record"), ref: suggestionRecordRef }),
  z.object({
    kind: z.literal("field"),
    entity: shortcodeEntity,
    field: z.string(),
  }),
  z.object({ kind: z.literal("value"), value: z.json() }),
  z.object({ kind: z.literal("amount"), amount: z.number() }),
  z.object({ kind: z.literal("date"), date: z.string() }),
]);
export type SuggestionSummaryPart = z.infer<typeof suggestionSummaryPart>;

/**
 * What accepting restores: a data-quality check it resolves, an outcome
 * that resolves no check, or a caution about what it may open.
 */
export const suggestionImpact = z.object({
  kind: z.enum(["quality_check", "outcome", "caution"]),
  label: z.string(),
  qualityCheck: dataCheck.optional(),
});
export type SuggestionImpact = z.infer<typeof suggestionImpact>;

export const suggestionActionVerb = z.enum([
  "accept",
  "correct",
  "reject",
  "dismiss",
  "never_suggest",
  "open_workbench",
]);
export type SuggestionActionVerb = z.infer<typeof suggestionActionVerb>;
/** `ownerOnly`: only the record's owner may take this action. */
export const suggestionAction = z.object({
  verb: suggestionActionVerb,
  ownerOnly: z.boolean(),
});

const rowBase = {
  assessmentId: assessmentChildHandle,
  /** Pass as `expectedFingerprint` when reviewing. */
  fingerprint: z.string().nullable(),
  record: suggestionRecordRef,
  other: suggestionRecordRef.optional(),
  summary: z.array(suggestionSummaryPart),
  strength: suggestionStrength,
  /** Bulk-acceptable as is through `suggestions.acceptClean`. */
  clean: z.boolean(),
  impact: z.array(suggestionImpact),
  matchedRules: z.array(z.string()),
  createdAt: z.iso.datetime(),
  actions: z.array(suggestionAction),
};

export const fieldSuggestionRow = z.object({
  ...rowBase,
  family: z.literal("field"),
  evidence: suggestionReviewRowSchema,
});
export const statementSuggestionRow = z.object({
  ...rowBase,
  family: z.literal("statement_transaction"),
  evidence: statementSuggestionOut,
});
export const recommendationSuggestionRow = z.object({
  ...rowBase,
  family: z.literal("recommendation"),
  evidence: connectionProposal,
});
/** One Suggestion of any family; `evidence` is the family's own payload. */
export const suggestionListRow = z.discriminatedUnion("family", [
  fieldSuggestionRow,
  statementSuggestionRow,
  recommendationSuggestionRow,
]);
export type SuggestionListRow = z.infer<typeof suggestionListRow>;

/** Filters scoped to one family; ignored by the others. */
export const suggestionFamilyScope = z.object({
  field: z
    .object({
      field: z.string().optional(),
      fields: z.array(z.string()).max(100).optional(),
      kind: z.enum(["correction", "addition"]).optional(),
      minConfidence: z.number().min(0).max(1).optional(),
    })
    .optional(),
  statement_transaction: statementSuggestionFilters
    .omit({ clean: true })
    .optional(),
  /** The top-level `entity` already matches either endpoint's kind. */
  recommendation: z
    .object({ relation: connectionRelation.optional() })
    .optional(),
});

export const SUGGESTION_RECORD_IDS_MAX = 250;
export const suggestionListFilters = z.object({
  family: suggestionListFamily.optional(),
  /** The record's kind (either endpoint for a connection). */
  entity: shortcodeEntity.optional(),
  /** Records of any kind by shortcode; a connection lists under both endpoints. */
  recordIds: z
    .array(z.string().min(1))
    .max(SUGGESTION_RECORD_IDS_MAX)
    .optional(),
  strength: suggestionStrength.optional(),
  /** Reviewed history is field-only (the decision-eval label set). */
  status: suggestionStatus.default("pending"),
  clean: z.boolean().optional(),
  runId: runShortcode.optional(),
  scope: suggestionFamilyScope.default({}),
});
export type SuggestionListFilters = z.output<typeof suggestionListFilters>;

export const SUGGESTION_LIST_PAGE_MAX = 200;
export const suggestionListInput = suggestionListFilters.extend({
  order: suggestionSort.default("ready"),
  /** The previous page's `next`. */
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(SUGGESTION_LIST_PAGE_MAX).default(50),
  /** Adds pending statement suggestions counted per account and month. */
  groups: z.enum(["account_month"]).optional(),
});
export type SuggestionListInput = z.input<typeof suggestionListInput>;

export const suggestionListOut = z.object({
  items: z.array(suggestionListRow),
  next: z.string().nullable(),
  groups: z.array(statementSuggestionGroupOut).optional(),
});
export type SuggestionListOut = z.infer<typeof suggestionListOut>;

export const suggestionFieldCount = z.object({
  entity: shortcodeEntity,
  field: z.string(),
  pending: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
});
export type SuggestionFieldCount = z.infer<typeof suggestionFieldCount>;

export const suggestionCountsInput = suggestionListFilters.omit({
  status: true,
});
const count = z.number().int().nonnegative();
/**
 * Pending, clean and per-Strength counts follow every filter. Reviewed
 * outcomes follow family, entity and runId; `fields` is the field family's
 * per-field breakdown.
 */
export const suggestionFamilyCount = z.object({
  family: suggestionListFamily,
  pending: count,
  clean: count,
  strong: count,
  medium: count,
  weak: count,
  applied: count,
  rejected: count,
  superseded: count,
  resolved: count,
  fields: z.array(suggestionFieldCount),
});
export type SuggestionFamilyCount = z.infer<typeof suggestionFamilyCount>;
export const suggestionCountsOut = z.object({
  families: z.array(suggestionFamilyCount),
});
export type SuggestionCountsOut = z.infer<typeof suggestionCountsOut>;

export const SUGGESTION_ACCEPT_CLEAN_MAX = 100;
export const acceptCleanSuggestionsInput = z.object({
  filters: suggestionListFilters.omit({ status: true, clean: true }).default({
    scope: {},
  }),
  limit: z.number().int().min(1).max(SUGGESTION_ACCEPT_CLEAN_MAX).default(100),
  /** Already attempted ids; a failed accept stays pending and clean. */
  skip: z.array(assessmentChildHandle).max(5000).default([]),
});
