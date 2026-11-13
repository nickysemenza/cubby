import { z } from "zod";
import {
  suggestionDeclaredFilters,
  suggestionFilterDeclaration,
} from "./suggestion-list-declarations";
import { transferPairJudgment } from "./transfer-pair-suggestion";

import { suggestionReviewRowSchema, suggestionStatus } from "./ai";
import { suggestionChildHandle } from "./suggestion-reference";
import {
  suggestionReviewBatchOut,
  suggestionReviewInput,
  suggestionSuppression,
} from "./suggestion";
import { dataCheck } from "./data-quality";
import { connectionProposal } from "./entity-connections";
import { shortcodeEntities } from "./generated/entity-roster.gen";
import { anyShortcodeSchema, nonEmptyTuple } from "./identifier-fields";
import { runShortcode } from "./identifiers";

/** Suggestion families the Suggestions page lists. */
export const suggestionListFamily = z.enum([
  "field",

  "recommendation",
  "transfer_pair",
  "product_pair",
]);
export type SuggestionListFamily = z.infer<typeof suggestionListFamily>;

/**
 * How well a Suggestion's own evidence supports it, judged by its family.
 * @public Names a generated native model.
 */
export const suggestionStrength = z.enum(["strong", "medium", "weak"]);
export type SuggestionStrength = z.infer<typeof suggestionStrength>;

const shortcodeEntity = z.enum(shortcodeEntities);
/** A record by shortcode and kind; clients resolve its label and marks. */
export const suggestionRecordRef = z.object({
  entity: shortcodeEntity,
  id: anyShortcodeSchema(nonEmptyTuple(shortcodeEntities)),
});
export type SuggestionRecordRef = z.infer<typeof suggestionRecordRef>;

/**
 * Structured summary parts; clients render each part with its own control.
 * @public Names a generated native model.
 */
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

/**
 * What accepting restores: a data-quality check it closes, another state it
 * resolves (a statement charge matched), or a caution about what it may open.
 * @public Names a generated native model.
 */
export const suggestionImpact = z.object({
  kind: z.enum(["quality_check", "resolves", "caution"]),
  label: z.string(),
  qualityCheck: dataCheck.optional(),
});
export type SuggestionImpact = z.infer<typeof suggestionImpact>;

/** @public Names a generated native model. */
export const suggestionActionVerb = z.enum([
  "accept",
  "correct",
  "reject",
  "dismiss",
  "never_suggest",
  "review_merge",
]);
export type SuggestionActionVerb = z.infer<typeof suggestionActionVerb>;
/** `ownerOnly`: only the record's owner may take this action. */
export const suggestionAction = z.object({
  verb: suggestionActionVerb,
  ownerOnly: z.boolean(),
});

/**
 * A column's filter and sort value. Refs hold shortcodes; a multi-valued
 * column (a connection's endpoint kinds) matches when any value does.
 * @public Names a generated native model.
 */
export const suggestionColumnValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type SuggestionColumnValue = z.infer<typeof suggestionColumnValue>;

const rowBase = {
  /** The Suggestion id: stable for a row until its evidence republishes. */
  id: suggestionChildHandle,
  suggestionId: suggestionChildHandle,
  /** Pass as `expectedFingerprint` when reviewing. */
  /** Pass as `expectedFingerprint` when reviewing this row. */
  fingerprint: z.string(),
  record: suggestionRecordRef,
  other: suggestionRecordRef.optional(),
  review: z
    .object({
      application: suggestionReviewInput.shape.application,
      suppression: suggestionSuppression.optional(),
      correction: z.object({ label: z.string(), value: z.string() }).optional(),
      merge: z
        .object({
          entity: shortcodeEntity,
          rows: z.array(z.object({ id: z.string(), name: z.string() })).min(2),
        })
        .optional(),
    })
    .optional(),
  summary: z.array(suggestionSummaryPart),
  strength: suggestionStrength,
  /** Bulk-acceptable as is through `suggestions.acceptClean`. */
  clean: z.boolean(),
  impact: z.array(suggestionImpact),
  /** Automatic rule stamps (`<ruleKey>@<revision>[@<model>]`) matched at publication. */
  matchedRules: z.array(z.string()),
  /** `<ruleKey>@<revision>` of the Automatic rule that applied it, else null. */
  automaticRule: z.string().nullable(),
  createdAt: z.iso.datetime(),
  actions: z.array(suggestionAction),
  /** The row's declared relation values, as filtered and sorted. */
  columns: z.record(
    z.string(),
    z.union([suggestionColumnValue, z.array(suggestionColumnValue)]),
  ),
};

/**
 * Server-owned evidence for additional proposal scopes; clients share one renderer.
 * @public Names a generated native model.
 */
export const declaredSuggestionEvidence = z.object({
  kind: z.literal("declared"),
  description: z.string(),
  facts: z.array(z.object({ label: z.string(), value: z.json() })),
});
export type DeclaredSuggestionEvidence = z.infer<
  typeof declaredSuggestionEvidence
>;

export const fieldSuggestionRow = z.object({
  ...rowBase,
  family: z.literal("field"),
  evidence: suggestionReviewRowSchema,
});

export const recommendationSuggestionRow = z.object({
  ...rowBase,
  family: z.literal("recommendation"),
  evidence: z.union([connectionProposal, declaredSuggestionEvidence]),
});
export const transferPairSuggestionRow = z.object({
  ...rowBase,
  family: z.literal("transfer_pair"),
  evidence: transferPairJudgment,
});
export const productPairSuggestionRow = z.object({
  ...rowBase,
  family: z.literal("product_pair"),
  evidence: declaredSuggestionEvidence,
});
/**
 * One Suggestion of any family; `evidence` is the family's own payload.
 * @public Names a generated native model.
 */
export const suggestionListRow = z.discriminatedUnion("family", [
  fieldSuggestionRow,

  recommendationSuggestionRow,
  transferPairSuggestionRow,
  productPairSuggestionRow,
]);
export type SuggestionListRow = z.infer<typeof suggestionListRow>;

export const SUGGESTION_RECORD_IDS_MAX = 250;
const suggestionScope = z.object({
  family: suggestionListFamily.optional(),
  /** The record's kind (either endpoint for a connection). */
  recordEntity: shortcodeEntity.optional(),
  /** Subject records by shortcode; a connection lists under both endpoints. */
  recordIds: z
    .array(z.string().min(1))
    .max(SUGGESTION_RECORD_IDS_MAX)
    .optional(),
  /** Reviewed history: field rows in every status (the decision-eval label set), statement rows applied. */
  status: suggestionStatus.default("pending"),
  runId: runShortcode.optional(),
});
const suggestionListFilters = suggestionDeclaredFilters.extend(
  suggestionScope.shape,
);
export type SuggestionListFilters = z.output<typeof suggestionListFilters>;

const SUGGESTION_LIST_PAGE_MAX = 200;
const suggestionPaging = z.object({
  ...suggestionScope.shape,
  sort: suggestionFilterDeclaration.input.shape.sort,
  cursor: z.string().min(1).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(SUGGESTION_LIST_PAGE_MAX).default(50),
});
export const suggestionListInput = suggestionDeclaredFilters.extend(
  suggestionPaging.shape,
);

export const suggestionListOut = z.object({
  items: z.array(suggestionListRow),
  meta: z.object({
    pageIndex: z.number().int(),
    pageSize: z.number().int(),
    totalCount: z.number().int(),
    cleanCount: z.number().int().nonnegative(),
  }),
  /** Keyset cursor for the next page; null on the last. */
  next: z.string().nullable(),
});
export type SuggestionListOut = z.infer<typeof suggestionListOut>;

const suggestionFieldCount = z.object({
  entity: shortcodeEntity,
  field: z.string(),
  pending: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
});
export type SuggestionFieldCount = z.infer<typeof suggestionFieldCount>;

const suggestionCountScope = suggestionScope.omit({ status: true });
export const suggestionCountsInput = suggestionDeclaredFilters
  .extend(suggestionCountScope.shape)
  .and(suggestionCountScope);
const count = z.number().int().nonnegative();
/**
 * Pending, clean and per-Strength counts follow every filter. Reviewed
 * outcomes follow family, entity and runId; `fields` is the field family's
 * per-field breakdown.
 */
const suggestionFamilyCount = z.object({
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
export const suggestionCountsOut = z.object({
  families: z.array(suggestionFamilyCount),
});
export type SuggestionCountsOut = z.infer<typeof suggestionCountsOut>;

export const SUGGESTION_ACCEPT_CLEAN_MAX = 100;
/** Failed ids one bulk accept may carry forward as `skip`. */
export const SUGGESTION_ACCEPT_SKIP_MAX = 5000;
export const acceptCleanSuggestionsInput = z.object({
  filters: suggestionCountsInput.default({}),
  limit: z.number().int().min(1).max(SUGGESTION_ACCEPT_CLEAN_MAX).default(100),
  /** Already attempted ids; a failed accept stays pending and clean. */
  skip: z
    .array(suggestionChildHandle)
    .max(SUGGESTION_ACCEPT_SKIP_MAX)
    .default([]),
});

/** An overlapping suggestion is settled by the pair accepted in this batch, without a second review. */
export const acceptCleanSuggestionsOut = z.array(
  z.union([
    suggestionReviewBatchOut.element,
    z.object({
      suggestionId: suggestionChildHandle,
      ok: z.literal(true),
      applied: z.literal(false),
      status: z.literal("settled_by_pair"),
      reason: z.string(),
    }),
  ]),
);
