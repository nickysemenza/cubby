import { humanize } from "@cubby/shared";
import type { z } from "zod";
import { connectionRelation } from "./entity-connections";
import { shortcodeEntities } from "./generated/entity-roster.gen";
import { entityRoster } from "./generated/entity-roster.gen";

import { defineRelationList, type RelationFilter } from "./relation-list";

const options = (values: readonly string[]) =>
  values.map((value) => ({ value, label: humanize(value) }));
const entities = shortcodeEntities.map((value) => ({
  value,
  label: entityRoster[value].singular,
}));
const strength = {
  columnId: "strength",
  label: "Strength",
  kind: "multiselect",
  options: options(["strong", "medium", "weak"]),
} as const;
const clean = {
  columnId: "clean",
  label: "Clean",
  kind: "multiselect",
  options: [
    { value: "true", label: "Clean" },
    { value: "false", label: "Needs review" },
  ],
} as const;
const date = {
  columnId: "date",
  label: "Date",
  kind: "range",
  range: "date",
} as const;
const amount = {
  columnId: "amount",
  label: "Amount",
  kind: "range",
  range: "number",
} as const;
const account = {
  columnId: "account",
  label: "Account",
  kind: "multiselect",
  reference: "financialAccount",
  array: true,
} as const;

const owner = {
  columnId: "owner",
  label: "Owner",
  kind: "multiselect",
  reference: "ledgerParty",
  array: true,
  nullable: { label: "Owner" },
} as const;
const merchant = {
  columnId: "merchant",
  label: "Merchant",
  kind: "text",
  array: true,
} as const;

const filters = {
  all: [strength, clean],
  field: [
    {
      columnId: "entity",
      label: "Entity",
      kind: "multiselect",
      options: entities,
    },
    { columnId: "field", label: "Field", kind: "multiselect" },
    {
      columnId: "kind",
      label: "Kind",
      kind: "multiselect",
      options: options(["correction", "addition"]),
    },
    {
      columnId: "disposition",
      label: "Needs",
      kind: "multiselect",
      options: [
        { value: "disagreement", label: "Disagreement" },
        { value: "needs_you", label: "Needs you" },
        { value: "guess", label: "Guess" },
      ],
    },
    {
      columnId: "confidence",
      label: "Confidence (0 to 1)",
      kind: "range",
      range: "number",
    },
    strength,
  ],

  recommendation: [
    {
      columnId: "relation",
      label: "Relation",
      kind: "multiselect",
      options: options(connectionRelation.options),
    },
    {
      columnId: "entityKind",
      label: "Record kinds",
      kind: "multiselect",
      array: true,
      options: entities,
    },
    strength,
  ],
  transfer_pair: [
    date,
    { ...account, array: true },
    { ...owner, array: true },
    merchant,
    amount,
    {
      columnId: "dateGapDays",
      label: "Date gap",
      kind: "range",
      range: "number",
    },
    strength,
    clean,
  ],
} as const satisfies Record<string, readonly RelationFilter[]>;

type ViewFilter = (typeof filters)[keyof typeof filters][number];
export type SuggestionFilterSearchKey =
  | ViewFilter["columnId"]
  | "month"
  | `${Extract<ViewFilter, { kind: "multiselect" | "idMulti" }>["columnId"] | "month"}Exclude`
  | `${Extract<ViewFilter, { nullable: {} }>["columnId"]}Presence`;

const commonSorts = [
  { key: "ready", label: "Clean first · strongest · newest" },
  { key: "impact", label: "Most impact" },
  { key: "strength", label: "Strength", column: "strengthRank" },
  { key: "clean", label: "Clean" },
  { key: "createdAt", label: "Created" },
] as const;

const declare = (fields: readonly RelationFilter[]) =>
  defineRelationList({
    filters: fields,
    sorts: [
      ...commonSorts,
      ...fields
        .filter(
          (field) => !commonSorts.some((sort) => sort.key === field.columnId),
        )
        .map((field) => ({ key: field.columnId, label: field.label })),
      { key: "source", label: "Record" },
      { key: "target", label: "Other record" },
    ],
    defaultSort: { orderBy: "ready", direction: "desc" },
    grouping: [],
    views: [],
    pageSize: { default: 50, max: 200 },
  });

/** Each page family owns its filters, codec, sorts and SQL descriptors. */
export const suggestionRelationLists = {
  all: declare(filters.all),
  field: declare(filters.field),

  recommendation: declare(filters.recommendation),
  transfer_pair: declare(filters.transfer_pair),
};

// The cross-family operation accepts the union of declared fields. A shared
// column's value roster is the union; each family still compiles its own type.
const byColumn = new Map<string, RelationFilter>();
const declaredFields: readonly RelationFilter[] = Object.values(filters).flat();
for (const field of declaredFields) {
  const previous = byColumn.get(field.columnId);
  byColumn.set(
    field.columnId,
    previous
      ? {
          ...previous,
          options: [
            ...new Map(
              [...(previous.options ?? []), ...(field.options ?? [])].map(
                (option) => [option.value, option],
              ),
            ).values(),
          ],
        }
      : field,
  );
}
export const suggestionFilterDeclaration = declare([...byColumn.values()]);
// SAFETY: `filterInput` is built from these same declarations at runtime; the
// views' union of columns types each search key it accepts.
export const suggestionDeclaredFilters =
  suggestionFilterDeclaration.filterInput as z.ZodObject<
    {
      [K in SuggestionFilterSearchKey]: z.ZodOptional<
        z.ZodType<string | string[]>
      >;
    },
    z.core.$strict
  >;

/** The same option label in the filter, row and evidence detail. */
export function suggestionValueLabel(column: string, value: string): string {
  const declared = Object.values(suggestionRelationLists)
    .flatMap((list) =>
      list.filters.flatMap((filter) =>
        filter.columnId === column && "options" in filter
          ? (filter.options ?? [])
          : [],
      ),
    )
    .find((option) => option.value === value);
  if (declared) return declared.label;
  const evidenceLabels = {
    high: "High",
    medium: "Medium",
    low: "Low",
    yes: "Same",
    no: "Different",
    uncertain: "Unsure",
    account_move: "Account move",
    payment: "Payment",
    insufficient_evidence: "Insufficient evidence",
    explicit: "Explicit",
    weak: "Weak",
    none: "None",
    transaction: "Transaction",
    statement: "Statement",
    cash: "Cash",
    monarch: "Monarch",
    mint: "Mint",
    copilot: "Copilot",
    apple_card: "Apple Card",
    manual: "Manual",
    completed: "Done",
    pending: "Waiting",
    posted: "Done",
    voided: "Ended",
  };
  return (
    Object.entries(evidenceLabels).find(([key]) => key === value)?.[1] ?? value
  );
}
