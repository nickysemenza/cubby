import { z } from "zod";
import { transferPairJudgment } from "./transfer-pair-suggestion";

import { suggestionReviewRowSchema, suggestionStatus } from "./ai";
import { assessmentChildHandle } from "./assessment-reference";
import { dataCheck } from "./data-quality";
import { connectionProposal, connectionRelation } from "./entity-connections";
import { shortcodeEntities } from "./entity-manifest";
import { generatedFinancialTransactionKindValues } from "./generated/entity-field-schemas.financialTransaction.gen";
import { anyShortcodeSchema, nonEmptyTuple } from "./identifier-fields";
import {
  financialAccountShortcode,
  ledgerPartyShortcode,
  runShortcode,
} from "./identifiers";
import {
  statementSuggestionOut,
  statementTransactionAction,
  statementTransactionKindSource,
} from "./statement-suggestion";

/** Assessment families the Suggestions page lists. */
export const suggestionListFamily = z.enum([
  "field",
  "statement_transaction",
  "recommendation",
  "transfer_pair",
]);
export type SuggestionListFamily = z.infer<typeof suggestionListFamily>;

/** How well a Suggestion's own evidence supports it, judged by its family. */
export const suggestionStrength = z.enum(["strong", "medium", "weak"]);
export type SuggestionStrength = z.infer<typeof suggestionStrength>;

const shortcodeEntity = z.enum(shortcodeEntities);
/** A record by shortcode and kind; clients resolve its label and marks. */
export const suggestionRecordRef = z.object({
  entity: shortcodeEntity,
  id: anyShortcodeSchema(nonEmptyTuple(shortcodeEntities)),
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
 * What accepting restores: a data-quality check it closes, another state it
 * resolves (a statement charge matched), or a caution about what it may open.
 */
export const suggestionImpact = z.object({
  kind: z.enum(["quality_check", "resolves", "caution"]),
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

/**
 * A column's filter and sort value. Refs hold shortcodes; a multi-valued
 * column (a connection's endpoint kinds) matches when any value does.
 */
export const suggestionColumnValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type SuggestionColumnValue = z.infer<typeof suggestionColumnValue>;

type ColumnType =
  | { type: "text" }
  | { type: "number" }
  | { type: "date" }
  | { type: "boolean" }
  | { type: "enum"; values: readonly string[] }
  | { type: "ref"; entity: (typeof shortcodeEntities)[number] };

/**
 * Every server-filterable, sortable column, by family; `common` columns are
 * on every row. `facet` columns return value counts beside the page.
 */
export const suggestionColumns = {
  common: {
    family: {
      type: "enum",
      values: suggestionListFamily.options,
      facet: true,
    },
    strength: {
      type: "enum",
      values: suggestionStrength.options,
      facet: true,
    },
    clean: { type: "boolean", facet: true },
    createdAt: { type: "date" },
    /** Data-quality checks acceptance restores. */
    impact: { type: "number" },
  },
  field: {
    entity: { type: "enum", values: shortcodeEntities, facet: true },
    field: { type: "text", facet: true },
    kind: { type: "enum", values: ["correction", "addition"], facet: true },
    confidence: { type: "number" },
  },
  statement_transaction: {
    date: { type: "date" },
    /** `YYYY-MM` of the statement date; the grouping month. */
    month: { type: "text" },
    account: { type: "ref", entity: "financialAccount", facet: true },
    owner: { type: "ref", entity: "ledgerParty", facet: true },
    /** Merchant and raw description, searched together. */
    merchant: { type: "text" },
    amount: { type: "number" },
    action: {
      type: "enum",
      values: statementTransactionAction.options,
      facet: true,
    },
    kind: {
      type: "enum",
      values: generatedFinancialTransactionKindValues,
      facet: true,
    },
    kindSource: {
      type: "enum",
      values: statementTransactionKindSource.options,
    },
    providerCategory: { type: "text" },
    providerStatus: { type: "enum", values: ["posted", "pending"] },
    candidate: { type: "ref", entity: "financialTransaction" },
    /** The first candidate's advisory label, `<same>:<confidence>`. */
    modelLabel: { type: "text" },
  },
  recommendation: {
    relation: {
      type: "enum",
      values: connectionRelation.options,
      facet: true,
    },
    /** Either endpoint's kind. */
    entityKind: { type: "enum", values: shortcodeEntities, facet: true },
    source: { type: "text" },
    target: { type: "text" },
  },
  transfer_pair: {
    date: { type: "date" },
    amount: { type: "number" },
    dateGapDays: { type: "number" },
    account: { type: "ref", entity: "financialAccount", facet: true },
    owner: { type: "ref", entity: "ledgerParty", facet: true },
    merchant: { type: "text" },
  },
} as const satisfies Record<
  "common" | SuggestionListFamily,
  Record<string, ColumnType & { facet?: true }>
>;

const rowBase = {
  /** The Assessment id: stable for a row until its evidence republishes. */
  id: assessmentChildHandle,
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
  /** Automatic rule stamps (`<ruleKey>@<revision>[@<model>]`) matched at publication. */
  matchedRules: z.array(z.string()),
  /** `<ruleKey>@<revision>` of the Automatic rule that applied it, else null. */
  automaticRule: z.string().nullable(),
  createdAt: z.iso.datetime(),
  actions: z.array(suggestionAction),
  /** The row's `suggestionColumns` values, as filtered and sorted. */
  columns: z.record(
    z.string(),
    z.union([suggestionColumnValue, z.array(suggestionColumnValue)]),
  ),
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
export const transferPairSuggestionRow = z.object({
  ...rowBase,
  family: z.literal("transfer_pair"),
  evidence: transferPairJudgment,
});
/** One Suggestion of any family; `evidence` is the family's own payload. */
export const suggestionListRow = z.discriminatedUnion("family", [
  fieldSuggestionRow,
  statementSuggestionRow,
  recommendationSuggestionRow,
  transferPairSuggestionRow,
]);
export type SuggestionListRow = z.infer<typeof suggestionListRow>;

/** One column's condition; every given part must hold. */
export const suggestionColumnFilter = z.object({
  in: z.array(suggestionColumnValue).max(200).optional(),
  min: z.union([z.number(), z.string()]).optional(),
  max: z.union([z.number(), z.string()]).optional(),
  /** Case-insensitive substring of a text column. */
  search: z.string().min(1).optional(),
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
  /** Reviewed history: field rows in every status (the decision-eval label set), statement rows applied. */
  status: suggestionStatus.default("pending"),
  /** Only Suggestions an Automatic rule applied; implies status applied. */
  appliedAutomatically: z.boolean().optional(),
  runId: runShortcode.optional(),
  /** Conditions on `suggestionColumns`, by column key. */
  where: z.record(z.string(), suggestionColumnFilter).default({}),
});
export type SuggestionListFilters = z.output<typeof suggestionListFilters>;

/** `ready`: clean, then Strength, then newest. `impact`: checks restored, then `ready`. */
export const suggestionOrder = z.object({
  by: z.string().min(1),
  direction: z.enum(["asc", "desc"]).default("desc"),
});
export type SuggestionOrder = z.output<typeof suggestionOrder>;

export const SUGGESTION_LIST_PAGE_MAX = 200;
export const suggestionListInput = suggestionListFilters.extend({
  /** Sort stack, primary first; ties end on the Assessment id. */
  order: z
    .array(suggestionOrder)
    .max(4)
    .default([{ by: "ready", direction: "desc" }]),
  /** The previous page's `next` (keyset); takes precedence over `offset`. */
  cursor: z.string().min(1).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(SUGGESTION_LIST_PAGE_MAX).default(50),
  /** Groups statement suggestions by account and month, groups first in order. */
  groups: z.enum(["account_month"]).optional(),
});
export type SuggestionListInput = z.input<typeof suggestionListInput>;

/** One account × month section of the grouped statement list. */
export const suggestionGroup = z.object({
  key: z.string().min(1),
  /** The month, `YYYY-MM`; the account is `accountId`. */
  label: z.string().min(1),
  count: z.number().int().positive(),
  clean: z.number().int().nonnegative(),
  /** Counts by recommended action, and the summed charge amount. */
  create: z.number().int().nonnegative(),
  attach: z.number().int().nonnegative(),
  supersede: z.number().int().nonnegative(),
  void: z.number().int().nonnegative(),
  amount: z.number(),
  accountId: financialAccountShortcode,
  ownerId: ledgerPartyShortcode.nullable(),
  month: z.string(),
});

export type SuggestionGroup = z.infer<typeof suggestionGroup>;

export const suggestionFacet = z.array(
  z.object({ value: suggestionColumnValue, count: z.number().int() }),
);

export const suggestionListOut = z.object({
  items: z.array(suggestionListRow),
  meta: z.object({
    pageIndex: z.number().int(),
    pageSize: z.number().int(),
    totalCount: z.number().int(),
    groups: z.array(suggestionGroup).optional(),
  }),
  /** Value counts per facet column over the filtered set, ignoring that column's own filter. */
  facets: z.record(z.string(), suggestionFacet),
  /** Keyset cursor for the next page; null on the last. */
  next: z.string().nullable(),
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
  appliedAutomatically: true,
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
/** Failed ids one bulk accept may carry forward as `skip`. */
export const SUGGESTION_ACCEPT_SKIP_MAX = 5000;
export const acceptCleanSuggestionsInput = z.object({
  filters: suggestionListFilters
    .omit({ status: true, appliedAutomatically: true })
    .default({ where: {} }),
  limit: z.number().int().min(1).max(SUGGESTION_ACCEPT_CLEAN_MAX).default(100),
  /** Already attempted ids; a failed accept stays pending and clean. */
  skip: z
    .array(assessmentChildHandle)
    .max(SUGGESTION_ACCEPT_SKIP_MAX)
    .default([]),
});
