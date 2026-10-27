import { humanize } from "@cubby/shared";
import { connectionRelation } from "./entity-connections";
import { shortcodeEntities } from "./entity-manifest";
import { entitySummary } from "./generated/entity-summary.gen";
import { generatedFinancialTransactionKindValues } from "./generated/entity-field-schemas.financialTransaction.gen";
import {
  defineRelationList,
  relationGroupChoice,
  type RelationFilter,
} from "./relation-list";
import { statementTransactionAction } from "./statement-suggestion";

const options = (values: readonly string[]) =>
  values.map((value) => ({ value, label: humanize(value) }));
const entities = shortcodeEntities.map((value) => ({
  value,
  label: entitySummary[value].singular,
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
} as const;
const owner = {
  columnId: "owner",
  label: "Owner",
  kind: "multiselect",
  reference: "ledgerParty",
  nullable: { label: "Owner" },
} as const;
const merchant = {
  columnId: "merchant",
  label: "Merchant",
  kind: "text",
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
      columnId: "confidence",
      label: "Confidence",
      kind: "range",
      range: "number",
    },
    strength,
  ],
  statement_transaction: [
    date,
    account,
    owner,
    merchant,
    amount,
    {
      columnId: "action",
      label: "Action",
      kind: "multiselect",
      options: statementTransactionAction.options.map((value) => ({
        value,
        label: {
          create: "Create",
          book: "Book spending",
          attach: "Attach",
          supersede: "Settle hold",
          void: "Void hold",
        }[value],
      })),
    },
    {
      columnId: "kind",
      label: "Kind",
      kind: "multiselect",
      options: options(generatedFinancialTransactionKindValues),
    },
    {
      columnId: "kindSource",
      label: "Kind source",
      kind: "multiselect",
      options: [
        { value: "rule", label: "Rule" },
        { value: "model", label: "Model" },
        { value: "sign", label: "Amount sign" },
      ],
    },
    clean,
    { columnId: "providerCategory", label: "Provider category", kind: "text" },
    {
      columnId: "providerStatus",
      label: "Provider status",
      kind: "multiselect",
      options: options(["posted", "pending"]),
    },
    {
      columnId: "candidate",
      label: "Candidate",
      kind: "multiselect",
      reference: "financialTransaction",
      nullable: { label: "Candidate" },
    },
    { columnId: "modelLabel", label: "Model label", kind: "text" },
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
export const suggestionAccountMonthGroup = relationGroupChoice({
  key: "account_month",
  label: "Account × month",
  column: "accountMonth",
  filter: null,
});
const declare = (fields: readonly RelationFilter[], grouping = false) =>
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
    grouping: grouping ? [suggestionAccountMonthGroup] : [],
    views: [],
    pageSize: { default: 50, max: 200 },
  });

/** Each page family owns its filters, codec, sorts and SQL descriptors. */
export const suggestionRelationLists = {
  all: declare(filters.all),
  field: declare(filters.field),
  statement_transaction: declare(filters.statement_transaction, true),
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
// Month also scopes the grouped bulk acceptance action.
byColumn.set("month", {
  columnId: "month",
  label: "Month",
  kind: "multiselect",
});
export const suggestionFilterDeclaration = declare(
  [...byColumn.values()],
  true,
);
export const suggestionDeclaredFilters =
  suggestionFilterDeclaration.filterInput;
