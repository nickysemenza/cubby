import { formatConfidence } from "@cubby/schemas/ai";
import { connectionRelation } from "@cubby/schemas/entity-connections";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { statementTransactionAction } from "@cubby/schemas/statement-suggestion";
import {
  suggestionStrength,
  type SuggestionColumnValue,
  type SuggestionListFamily,
  type SuggestionListFilters,
  type SuggestionListRow,
} from "@cubby/schemas/suggestion-list";
import { humanize } from "@cubby/shared";

import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { EntityIcon } from "~/entity/entities";
import type { FilterSpecCore } from "~/entity/filters";
import { renderOptionCell } from "~/entity/table/column-helpers";
import type { TableStateReturn } from "~/entity/table/use-table-state";
import { formatCurrency } from "~/lib/number-format";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { DateDisplay } from "~/ui/common/date-display";
import { StackedValue } from "~/ui/common/stacked-value";
import { buildSelectColumn } from "~/ui/data-table/row-selection";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/ui/data-table/table-features";
import {
  attachCubbyColumnMeta,
  type FilterConfig,
} from "~/ui/data-table/table-meta";
import type { RuntimeFilterOptions } from "~/ui/hooks/filter-option-types";
import {
  deferredFilterOptionSource,
  deferredRosterControls,
} from "~/ui/hooks/filter-option-types";
import { NoneValue } from "~/ui/primitives/none-value";

import { AuthorizedBy, AutomaticWrongCell } from "./automatic-rules";
import { kindAgreement } from "./statement-kind-votes";
import { SuggestionActionsCell, ExpandCell } from "./suggestion-actions";
import {
  ActionBadge,
  CleanBadge,
  FAMILY_LABEL,
  FieldValue,
  ImpactLabels,
  RecordLink,
  StrengthMark,
  SuggestionRecord,
  WhatChanges,
  fieldLabel,
} from "./suggestion-values";

/**
 * The table's view: every family's shared columns, one family's own, or the
 * changes Automatic rules applied.
 */
export type SuggestionView = "all" | SuggestionListFamily | "applied";

type Row = SuggestionListRow;
const helper = createCubbyColumnHelper<Row>();

/** How a column's table filter becomes the server's `where` condition. */
type ColumnFilterSpec = FilterSpecCore & {
  value: "string" | "boolean" | "range";
};

const multiselect = (columnId: string): ColumnFilterSpec => ({
  columnId,
  kind: "multiselect",
  value: "string",
});
const text = (columnId: string): ColumnFilterSpec => ({
  columnId,
  kind: "text",
  value: "string",
});
const range = (columnId: string): ColumnFilterSpec => ({
  columnId,
  kind: "text",
  value: "range",
});

/** Every view's filters; `entity`/`record`/`runId` scopes ride the route. */
const VIEW_FILTERS = {
  // The family chips own the family scope (the route's `family`).
  all: [
    multiselect("strength"),
    { columnId: "clean", kind: "multiselect", value: "boolean" },
  ],
  field: [
    multiselect("entity"),
    multiselect("field"),
    multiselect("kind"),
    range("confidence"),
    multiselect("strength"),
  ],
  statement_transaction: [
    range("date"),
    multiselect("account"),
    multiselect("owner"),
    text("merchant"),
    range("amount"),
    multiselect("action"),
    multiselect("kind"),
    multiselect("kindSource"),
    { columnId: "clean", kind: "multiselect", value: "boolean" },
    text("providerCategory"),
    multiselect("providerStatus"),
    multiselect("candidate"),
    text("modelLabel"),
  ],
  recommendation: [
    multiselect("relation"),
    multiselect("entityKind"),
    multiselect("strength"),
  ],
  applied: [],
} satisfies Record<SuggestionView, readonly ColumnFilterSpec[]>;

/** The filter codec's specs for a view (URL keys are the column ids). */
export const viewFilterSpecs = (
  view: SuggestionView,
): readonly FilterSpecCore[] => VIEW_FILTERS[view];

/** `a..b`, `a..` or `..b`; a bare value is the lower bound. */
function parseRange(raw: string, numeric: boolean) {
  const [from = "", to] = raw.includes("..") ? raw.split("..") : [raw];
  const bound = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (!numeric) return trimmed;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : undefined;
  };
  return { min: bound(from), max: bound(to) };
}

const NUMERIC_RANGES = new Set(["amount", "confidence"]);

/** The table's column filters as the server's `where`, one condition per column. */
export function buildWhere(
  view: SuggestionView,
  state: TableStateReturn,
): SuggestionListFilters["where"] {
  const where: SuggestionListFilters["where"] = {};
  for (const spec of VIEW_FILTERS[view]) {
    if (spec.value === "range") {
      const raw = state.getColumnFilter(spec.columnId);
      if (!raw) continue;
      const bounds = parseRange(raw, NUMERIC_RANGES.has(spec.columnId));
      // Confidence reads as a percentage in the filter, a fraction on the server.
      const scale = (value: number | string | undefined) =>
        spec.columnId === "confidence" && typeof value === "number"
          ? value / 100
          : value;
      const min = scale(bounds.min);
      const max = scale(bounds.max);
      if (min === undefined && max === undefined) continue;
      where[spec.columnId] = {
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      };
      continue;
    }
    if (spec.kind === "text") {
      const search = state.getColumnFilter(spec.columnId);
      if (search) where[spec.columnId] = { search };
      continue;
    }
    const values = state.getColumnFilterValues(spec.columnId);
    if (!values?.length) continue;
    where[spec.columnId] = {
      in: values.map((value): SuggestionColumnValue =>
        spec.value === "boolean" ? value === "true" : value,
      ),
    };
  }
  return where;
}

const options = (values: readonly string[], label = humanize): PickerOption[] =>
  values.map((value) => ({ value, label: label(value) }));

const STRENGTH_OPTIONS = options(suggestionStrength.options);
const CLEAN_OPTIONS: PickerOption[] = [
  { value: "true", label: "Clean" },
  { value: "false", label: "Needs review" },
];
const ACTION_OPTIONS = statementTransactionAction.options.map((action) => ({
  value: action,
  label: {
    create: "Create",
    attach: "Attach",
    supersede: "Settle hold",
    void: "Void hold",
  }[action],
}));
const KIND_OPTIONS = fieldEnumOptions("financialTransaction", "kind");
const KIND_SOURCE_OPTIONS: PickerOption[] = [
  { value: "rule", label: "Rule" },
  { value: "model", label: "Model" },
  { value: "sign", label: "Amount sign" },
];
const PROVIDER_STATUS_OPTIONS = options(["posted", "pending"]);
const FIELD_KIND_OPTIONS = options(["correction", "addition"]);
const RELATION_OPTIONS = options(connectionRelation.options);
const ENTITY_OPTIONS: PickerOption[] = shortcodeEntities.map((entity) => ({
  value: entity,
  label: entitySummary[entity].singular,
  icon: <EntityIcon entity={entity} />,
}));

const multiFilter = (
  placeholder: string,
  choices: PickerOption[],
): FilterConfig => ({
  placeholder,
  filterType: "multiselect",
  options: choices,
});
const textFilter = (placeholder: string): FilterConfig => ({
  placeholder,
  filterType: "text",
});

/** Columns shared by every view: selection, the evidence toggle, record. */
function leadingColumns(
  add: Parameters<Parameters<typeof createCubbyColumnCollection<Row>>[0]>[0],
) {
  add(buildSelectColumn<Row>());
  add(
    helper.display({
      id: "expand",
      header: "",
      size: 32,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: attachCubbyColumnMeta<Row>({ entityColumnRole: "selection" }),
      cell: ExpandCell,
    }),
  );
}

function actionsColumn(
  add: Parameters<Parameters<typeof createCubbyColumnCollection<Row>>[0]>[0],
) {
  add(
    helper.display({
      id: "actions",
      header: "Actions",
      size: 220,
      enableSorting: false,
      enableHiding: false,
      meta: attachCubbyColumnMeta<Row>({
        mobile: { slot: "trailing" },
      }),
      cell: SuggestionActionsCell,
    }),
  );
}

const recordColumn = helper.accessor((row) => row.record.id, {
  id: "record",
  header: "Record",
  size: 240,
  enableSorting: false,
  meta: attachCubbyColumnMeta<Row>({
    entityColumnRole: "identity",
    mobile: { slot: "title" },
  }),
  cell: ({ row }) => <SuggestionRecord row={row.original} />,
});

const strengthColumn = helper.accessor((row) => row.strength, {
  id: "strength",
  header: "Strength",
  size: 112,
  meta: attachCubbyColumnMeta<Row>({
    mobile: { slot: "meta", priority: 1, label: "Strength" },
    filterConfig: multiFilter("Filter strength", STRENGTH_OPTIONS),
  }),
  cell: ({ row }) =>
    row.original.clean ? (
      <span className="inline-flex items-center gap-1.5">
        <CleanBadge clean />
        <StrengthMark strength={row.original.strength} />
      </span>
    ) : (
      <StrengthMark strength={row.original.strength} />
    ),
});

const impactColumn = helper.accessor((row) => row.impact.length, {
  id: "impact",
  header: "Impact",
  size: 180,
  meta: attachCubbyColumnMeta<Row>({
    mobile: { slot: "meta", priority: 4, label: "Impact" },
  }),
  cell: ({ row }) => <ImpactLabels impact={row.original.impact} />,
});

const ageColumn = helper.accessor((row) => row.createdAt, {
  id: "createdAt",
  header: "Age",
  size: 96,
  meta: attachCubbyColumnMeta<Row>({
    mobile: { slot: "meta", priority: 5, label: "Age" },
  }),
  cell: ({ row }) => <DateDisplay timestamp={row.original.createdAt} />,
});

const cleanColumn = helper.accessor((row) => row.clean, {
  id: "clean",
  header: "Clean",
  size: 104,
  meta: attachCubbyColumnMeta<Row>({
    mobile: { slot: "meta", priority: 2, label: "Clean" },
    filterConfig: multiFilter("Filter clean", CLEAN_OPTIONS),
  }),
  cell: ({ row }) => <CleanBadge clean={row.original.clean} />,
});

const column = (row: Row, key: string) => {
  const value = row.columns[key];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
};
const columnText = (row: Row, key: string) => {
  const value = column(row, key);
  return typeof value === "string" ? value : null;
};

function allColumns() {
  return createCubbyColumnCollection<Row>((add) => {
    leadingColumns(add);
    add(recordColumn);
    add(
      helper.display({
        id: "whatChanges",
        header: "What changes",
        size: 320,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "subtitle", priority: 0, label: "What changes" },
        }),
        cell: ({ row }) => <WhatChanges row={row.original} />,
      }),
    );
    add(strengthColumn);
    add(
      helper.accessor((row) => row.family, {
        id: "family",
        header: "Family",
        size: 104,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 0, label: "Family" },
        }),
        cell: ({ row }) => FAMILY_LABEL[row.original.family],
      }),
    );
    add(cleanColumn);
    add(impactColumn);
    add(ageColumn);
    actionsColumn(add);
  });
}

function fieldColumns() {
  const evidence = (row: Row) => (row.family === "field" ? row.evidence : null);
  return createCubbyColumnCollection<Row>((add) => {
    leadingColumns(add);
    add(recordColumn);
    add(
      helper.accessor((row) => columnText(row, "field"), {
        id: "field",
        header: "Field",
        size: 148,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 0, label: "Field" },
          filterConfig: {
            placeholder: "Filter field",
            filterType: "multiselect",
            freeText: true,
          },
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          return value
            ? `${entitySummary[value.entity].singular} · ${fieldLabel(value.entity, value.field)}`
            : null;
        },
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "entity"), {
        id: "entity",
        header: "Entity",
        size: 112,
        meta: attachCubbyColumnMeta<Row>({
          filterConfig: multiFilter("Filter entity", ENTITY_OPTIONS),
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          return value ? entitySummary[value.entity].singular : null;
        },
      }),
    );
    const valueCell =
      (key: "currentValue" | "suggestedValue" | "runnerUpValue") =>
      ({ row }: { row: { original: Row } }) => {
        const value = evidence(row.original);
        if (!value) return null;
        return (
          <span className="inline-flex min-w-0 items-center gap-1">
            <FieldValue
              entity={value.entity}
              recordId={value.recordId}
              field={value.field}
              value={value[key]}
              suggested={key === "suggestedValue"}
            />
            {key === "runnerUpValue" && value.runnerUpConfidence !== null ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatConfidence(value.runnerUpConfidence)}
              </span>
            ) : null}
          </span>
        );
      };
    add(
      helper.display({
        id: "current",
        header: "Current",
        size: 180,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 3, label: "Current" },
        }),
        cell: valueCell("currentValue"),
      }),
    );
    add(
      helper.display({
        id: "suggested",
        header: "Suggested",
        size: 200,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "subtitle", priority: 0, label: "Suggested" },
        }),
        cell: valueCell("suggestedValue"),
      }),
    );
    add(
      helper.display({
        id: "runnerUp",
        header: "Runner-up",
        size: 200,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 4, label: "Runner-up" },
        }),
        cell: valueCell("runnerUpValue"),
      }),
    );
    add(
      helper.accessor((row) => column(row, "confidence"), {
        id: "confidence",
        header: "Confidence",
        size: 112,
        meta: attachCubbyColumnMeta<Row>({
          numeric: true,
          mobile: { slot: "meta", priority: 1, label: "Confidence" },
          filterConfig: textFilter("Min..max %, e.g. 50.."),
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          return value ? (
            <span className="tabular-nums">
              {formatConfidence(value.confidence)}
            </span>
          ) : null;
        },
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "kind"), {
        id: "kind",
        header: "Kind",
        size: 104,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 2, label: "Kind" },
          filterConfig: multiFilter("Filter kind", FIELD_KIND_OPTIONS),
        }),
        cell: ({ row }) => humanize(columnText(row.original, "kind") ?? ""),
      }),
    );
    add(strengthColumn);
    add(
      helper.accessor((row) => row.createdAt, {
        id: "createdAt",
        header: "Decision · Run",
        size: 200,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 6, label: "Decision" },
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          if (!value) return null;
          return (
            <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
              <span className="truncate">{value.model}</span>
              {value.runId ? (
                <>
                  <span aria-hidden>·</span>
                  <RecordLink record={{ entity: "run", id: value.runId }} />
                </>
              ) : null}
            </span>
          );
        },
      }),
    );
    actionsColumn(add);
  });
}

function statementColumns(
  rosters: RuntimeFilterOptions,
  providerCategoryLabel: string,
) {
  const evidence = (row: Row) =>
    row.family === "statement_transaction" ? row.evidence : null;
  const rosterFilter = (key: string, placeholder: string): FilterConfig => {
    const source = deferredFilterOptionSource(rosters[key]);
    return {
      placeholder,
      filterType: "multiselect",
      options: source?.options ?? [],
      ...deferredRosterControls(source),
    };
  };
  return createCubbyColumnCollection<Row>((add) => {
    leadingColumns(add);
    add(
      helper.accessor((row) => columnText(row, "date"), {
        id: "date",
        header: "Date",
        size: 96,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 0, label: "Date" },
          filterConfig: textFilter("From..to, e.g. 2026-05-01..2026-05-31"),
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          return value ? <DateDisplay start={value.statementDate} /> : null;
        },
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "account"), {
        id: "account",
        header: "Account",
        size: 168,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 1, label: "Account" },
          filterConfig: rosterFilter("account", "Filter account"),
        }),
        cell: ({ row }) => <RecordLink record={row.original.record} />,
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "owner"), {
        id: "owner",
        header: "Owner",
        size: 140,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 5, label: "Owner" },
          filterConfig: rosterFilter("owner", "Filter owner"),
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          return value?.ownerId ? (
            <RecordLink record={{ entity: "ledgerParty", id: value.ownerId }} />
          ) : (
            <NoneValue />
          );
        },
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "merchant"), {
        id: "merchant",
        header: "Merchant",
        size: 240,
        meta: attachCubbyColumnMeta<Row>({
          entityColumnRole: "identity",
          mobile: { slot: "title" },
          filterConfig: textFilter("Search merchant or description"),
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          if (!value) return null;
          return (
            <StackedValue
              primary={value.merchant ?? value.rawDescription}
              secondary={value.merchant ? value.rawDescription : null}
            />
          );
        },
      }),
    );
    add(
      helper.accessor((row) => column(row, "amount"), {
        id: "amount",
        header: "Amount",
        size: 104,
        meta: attachCubbyColumnMeta<Row>({
          numeric: true,
          mobile: { slot: "trailing", priority: 0, label: "Amount" },
          filterConfig: textFilter("Min..max, e.g. 10..50"),
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          return value ? (
            <span className="tabular-nums">{formatCurrency(value.amount)}</span>
          ) : null;
        },
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "action"), {
        id: "action",
        header: "Action",
        size: 104,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "subtitle", priority: 0, label: "Action" },
          filterConfig: multiFilter("Filter action", ACTION_OPTIONS),
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          return value ? <ActionBadge action={value.recommended} /> : null;
        },
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "kind"), {
        id: "kind",
        header: "Kind",
        size: 128,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 2, label: "Kind" },
          filterConfig: multiFilter("Filter kind", KIND_OPTIONS),
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          return value?.create ? (
            renderOptionCell(value.create.kind, KIND_OPTIONS)
          ) : (
            <NoneValue />
          );
        },
      }),
    );
    add(
      // Filters by the source that chose the kind; the cell reads the votes.
      helper.accessor((row) => columnText(row, "kindSource"), {
        id: "kindSource",
        header: "Kind source",
        size: 220,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 7, label: "Kind source" },
          filterConfig: multiFilter("Filter kind source", KIND_SOURCE_OPTIONS),
        }),
        cell: ({ row }) => {
          const create = evidence(row.original)?.create;
          return create ? (
            <span className="truncate text-muted-foreground">
              {kindAgreement(create).reason}
            </span>
          ) : (
            <NoneValue />
          );
        },
      }),
    );
    add(cleanColumn);
    add(
      helper.accessor((row) => columnText(row, "providerCategory"), {
        id: "providerCategory",
        // Verbatim provider evidence; it sets no spending category.
        header: providerCategoryLabel,
        size: 148,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 6, label: providerCategoryLabel },
          filterConfig: textFilter(
            `Search ${providerCategoryLabel.toLowerCase()}`,
          ),
        }),
        cell: ({ row }) =>
          columnText(row.original, "providerCategory") ?? <NoneValue />,
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "providerStatus"), {
        id: "providerStatus",
        header: "Status",
        size: 96,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 8, label: "Status" },
          filterConfig: multiFilter("Filter status", PROVIDER_STATUS_OPTIONS),
        }),
        cell: ({ row }) =>
          humanize(columnText(row.original, "providerStatus") ?? ""),
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "candidate"), {
        id: "candidate",
        header: "Candidate",
        size: 168,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 3, label: "Candidate" },
          filterConfig: rosterFilter("candidate", "Filter candidate"),
        }),
        cell: ({ row }) =>
          row.original.other ? (
            <RecordLink record={row.original.other} />
          ) : (
            <NoneValue />
          ),
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "modelLabel"), {
        id: "modelLabel",
        header: "Model label",
        size: 128,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 9, label: "Model label" },
          filterConfig: textFilter("Search model label"),
        }),
        cell: ({ row }) => {
          const label = evidence(row.original)?.candidates[0]?.label;
          return label ? (
            `${humanize(label.same)} · ${label.confidence}`
          ) : (
            <NoneValue />
          );
        },
      }),
    );
    add(impactColumn);
    actionsColumn(add);
  });
}

function recommendationColumns() {
  const evidence = (row: Row) =>
    row.family === "recommendation" ? row.evidence : null;
  return createCubbyColumnCollection<Row>((add) => {
    leadingColumns(add);
    add(recordColumn);
    add(
      helper.accessor((row) => columnText(row, "relation"), {
        id: "relation",
        header: "Relation",
        size: 200,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "subtitle", priority: 0, label: "Relation" },
          filterConfig: multiFilter("Filter relation", RELATION_OPTIONS),
        }),
        cell: ({ row }) => evidence(row.original)?.label ?? null,
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "target"), {
        id: "target",
        header: "Other record",
        size: 240,
        enableSorting: true,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 0, label: "Other record" },
        }),
        cell: ({ row }) =>
          row.original.other ? (
            <RecordLink record={row.original.other} />
          ) : null,
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "entityKind"), {
        id: "entityKind",
        header: "Record kinds",
        size: 140,
        meta: attachCubbyColumnMeta<Row>({
          filterConfig: multiFilter("Filter record kind", ENTITY_OPTIONS),
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          if (!value) return null;
          return `${entitySummary[value.source.entityKind].singular} → ${entitySummary[value.target.entityKind].singular}`;
        },
      }),
    );
    add(
      helper.display({
        id: "basis",
        header: "Basis",
        size: 280,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 1, label: "Basis" },
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          if (!value) return null;
          const [first, ...rest] = value.evidence.reasons;
          return (
            <span className="truncate text-muted-foreground">
              {first ?? "No stated basis"}
              {rest.length ? ` · +${rest.length}` : ""}
            </span>
          );
        },
      }),
    );
    add(strengthColumn);
    add(ageColumn);
    actionsColumn(add);
  });
}

/** Changes an Automatic rule applied: what changed, the rule, and Wrong…. */
function appliedColumns() {
  return createCubbyColumnCollection<Row>((add) => {
    add(
      helper.display({
        id: "expand",
        header: "",
        size: 32,
        enableSorting: false,
        enableHiding: false,
        enableResizing: false,
        meta: attachCubbyColumnMeta<Row>({ entityColumnRole: "selection" }),
        cell: ExpandCell,
      }),
    );
    add(recordColumn);
    add(
      helper.display({
        id: "whatChanges",
        header: "What changed",
        size: 320,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "subtitle", priority: 0, label: "What changed" },
        }),
        cell: ({ row }) => <WhatChanges row={row.original} />,
      }),
    );
    add(
      helper.accessor((row) => row.automaticRule, {
        id: "automaticRule",
        header: "Authorized by",
        size: 260,
        enableSorting: false,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 0, label: "Authorized by" },
        }),
        cell: ({ row }) => <AuthorizedBy row={row.original} />,
      }),
    );
    add(
      helper.accessor((row) => row.family, {
        id: "family",
        header: "Family",
        size: 104,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 1, label: "Family" },
        }),
        cell: ({ row }) => FAMILY_LABEL[row.original.family],
      }),
    );
    add(ageColumn);
    add(
      helper.display({
        id: "actions",
        header: "",
        size: 160,
        enableSorting: false,
        enableHiding: false,
        meta: attachCubbyColumnMeta<Row>({ mobile: { slot: "trailing" } }),
        cell: ({ row }) => <AutomaticWrongCell row={row.original} />,
      }),
    );
  });
}

/** Rosters for the statement reference filters, read only when opened. */
export const STATEMENT_ROSTERS = [
  { key: "account", target: "financialAccount" },
  { key: "owner", target: "ledgerParty" },
  { key: "candidate", target: "financialTransaction" },
] as const;

export function viewColumns(
  view: SuggestionView,
  rosters: RuntimeFilterOptions,
  providerCategoryLabel: string,
): CubbyColumnCollection<Row> {
  switch (view) {
    case "all":
      return allColumns();
    case "field":
      return fieldColumns();
    case "statement_transaction":
      return statementColumns(rosters, providerCategoryLabel);
    case "recommendation":
      return recommendationColumns();
    case "applied":
      return appliedColumns();
  }
}

/** Columns a view keeps behind the column menu until asked for. */
export const VIEW_HIDDEN_COLUMNS = {
  // The Strength cell carries the Clean mark in the mixed view.
  all: { clean: false },
  field: { entity: false, strength: false },
  statement_transaction: {
    kindSource: false,
    providerStatus: false,
    modelLabel: false,
    impact: false,
  },
  recommendation: { entityKind: false },
  applied: {},
} satisfies Record<SuggestionView, Record<string, false>>;
