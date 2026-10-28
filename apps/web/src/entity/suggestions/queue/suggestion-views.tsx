import { formatConfidence } from "@cubby/schemas/ai";
import { shortcodeEntities, entityRoster } from "@cubby/schemas/entity-roster";
import {
  type SuggestionListFamily,
  type SuggestionListRow,
} from "@cubby/schemas/suggestion-list";
import {
  suggestionFilterDeclaration,
  suggestionRelationLists,
} from "@cubby/schemas/suggestion-list-declarations";
import { humanize } from "@cubby/shared";
import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { EntityIcon } from "~/entity/entities";
import {
  buildFiltersFromManifest,
  type FilterSpecCore,
} from "~/entity/filters";
import {
  createImageColumn,
  renderOptionCell,
} from "~/entity/table/column-helpers";
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
  FieldSummary,
} from "./suggestion-values";

/**
 * The table's view: every family's shared columns or one family's own.
 */
export type SuggestionView = "all" | SuggestionListFamily;

type Row = SuggestionListRow;
const helper = createCubbyColumnHelper<Row>();

/** Codec specs are generated from each family's relation declaration. */
export const viewFilterSpecs = (
  view: SuggestionView,
): readonly FilterSpecCore[] =>
  (view === "product_pair" || view === "image_description"
    ? suggestionRelationLists.all
    : suggestionRelationLists[view]
  ).specs;

/** Specialized views override the generic defaults only where their columns differ. */
export function viewSetting<Value>(
  registry: Partial<Record<SuggestionView, Value>>,
  view: SuggestionView,
): Value | undefined {
  return registry[view];
}

/** The shared list codec owns include/exclude, presence and range inputs. */
export function buildSuggestionFilters(
  view: SuggestionView,
  state: Pick<TableStateReturn, "getColumnFilter" | "getColumnFilterValues">,
) {
  return buildFiltersFromManifest(
    viewFilterSpecs(view),
    (column) =>
      state.getColumnFilterValues(column) ?? state.getColumnFilter(column),
  );
}

const declaredOptions = (
  view: keyof typeof suggestionRelationLists,
  column: string,
): PickerOption[] => [
  ...(suggestionRelationLists[view].filters.find(
    (filter) => filter.columnId === column,
  )?.options ?? []),
];

const STRENGTH_OPTIONS = declaredOptions("all", "strength");
const CLEAN_OPTIONS = declaredOptions("all", "clean");
const ACTION_OPTIONS = declaredOptions("statement_transaction", "action");
const kindOptions = (queryClient: QueryClient) => {
  const presented = fieldEnumOptions(
    queryClient,
    "financialTransaction",
    "kind",
  );
  return declaredOptions("statement_transaction", "kind").map(
    (option) =>
      presented.find((candidate) => candidate.value === option.value) ?? option,
  );
};
const KIND_SOURCE_OPTIONS = declaredOptions(
  "statement_transaction",
  "kindSource",
);
const PROVIDER_STATUS_OPTIONS = declaredOptions(
  "statement_transaction",
  "providerStatus",
);
const FIELD_KIND_OPTIONS = declaredOptions("field", "kind");
const RELATION_OPTIONS = declaredOptions("recommendation", "relation");
const ENTITY_OPTIONS = shortcodeEntities.map((entity) => ({
  value: entity,
  label:
    declaredOptions("field", "entity").find((option) => option.value === entity)
      ?.label ?? entityRoster[entity].singular,
  icon: <EntityIcon entity={entity} />,
}));

const multiFilter = (
  placeholder: string,
  choices: PickerOption[],
): FilterConfig => ({
  placeholder,
  filterType: "multiselect",
  exclude: true,
  options: choices,
});
const textFilter = (placeholder: string): FilterConfig => ({
  placeholder,
  filterType: "text",
});

/** Columns shared by every view: selection, the evidence toggle, and the
 * suggested record's image. */
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
  add(
    createImageColumn(helper, {
      imageRef: (row) => ({
        entityKind: row.record.entity,
        entityId: row.record.id,
      }),
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
    mobile: { slot: "title", renderTitle: true },
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
        cell: ({ row }) => (
          <span
            className="block truncate"
            title={FAMILY_LABEL[row.original.family]}
          >
            {FAMILY_LABEL[row.original.family]}
          </span>
        ),
      }),
    );
    add(cleanColumn);
    add(impactColumn);
    add(ageColumn);
    actionsColumn(add);
  });
}

/** Money-out and money-in values of one pair, in leg order. */
function TransferPairLegs({
  outflow,
  inflow,
}: {
  outflow: ReactNode;
  inflow: ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {outflow}
      <span aria-hidden="true" className="text-muted-foreground">
        →
      </span>
      <span className="sr-only">to</span>
      {inflow}
    </span>
  );
}

function transferPairColumns(rosters: RuntimeFilterOptions) {
  const evidence = (row: Row) =>
    row.family === "transfer_pair" ? row.evidence : null;
  return createCubbyColumnCollection<Row>((add) => {
    leadingColumns(add);
    add(recordColumn);
    add(
      helper.display({
        id: "whatChanges",
        header: "What changes",
        size: 320,
        cell: ({ row }) => <WhatChanges row={row.original} />,
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "date"), {
        id: "date",
        header: "Date",
        size: 108,
        cell: ({ row }) => (
          <DateDisplay start={columnText(row.original, "date")} />
        ),
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "account"), {
        id: "account",
        header: "Accounts",
        size: 220,
        meta: attachCubbyColumnMeta<Row>({
          filterConfig: rosterFilterConfig(
            rosters,
            "account",
            "Filter account",
          ),
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          return value ? (
            <TransferPairLegs
              outflow={
                <RecordLink
                  record={{
                    entity: "financialAccount",
                    id: value.outflow.accountId,
                  }}
                />
              }
              inflow={
                <RecordLink
                  record={{
                    entity: "financialAccount",
                    id: value.inflow.accountId,
                  }}
                />
              }
            />
          ) : null;
        },
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "owner"), {
        id: "owner",
        header: "Owners",
        size: 200,
        meta: attachCubbyColumnMeta<Row>({
          mobile: { slot: "meta", priority: 1, label: "Owners" },
          filterConfig: rosterFilterConfig(rosters, "owner", "Filter owner"),
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          if (!value) return null;
          const owner = (leg: typeof value.outflow) =>
            leg.owner ? (
              <RecordLink
                record={{ entity: "ledgerParty", id: leg.owner.id }}
              />
            ) : (
              <NoneValue />
            );
          return (
            <TransferPairLegs
              outflow={owner(value.outflow)}
              inflow={owner(value.inflow)}
            />
          );
        },
      }),
    );
    add(
      helper.accessor((row) => columnText(row, "merchant"), {
        id: "merchant",
        header: "Merchant",
        size: 200,
        meta: attachCubbyColumnMeta<Row>({
          filterConfig: textFilter("Search merchant or description"),
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          const merchant = value?.outflow.merchant ?? value?.inflow.merchant;
          return merchant ?? <NoneValue />;
        },
      }),
    );
    add(
      helper.accessor((row) => column(row, "amount"), {
        id: "amount",
        header: "Amount",
        size: 112,
        cell: ({ row }) => {
          const amount = column(row.original, "amount");
          return typeof amount === "number" ? (
            formatCurrency(amount)
          ) : (
            <NoneValue />
          );
        },
      }),
    );
    add(
      helper.accessor((row) => column(row, "dateGapDays"), {
        id: "dateGapDays",
        header: "Days apart",
        size: 100,
        cell: ({ row }) => column(row.original, "dateGapDays"),
      }),
    );
    add(strengthColumn);
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
            exclude: true,
            freeText: true,
          },
        }),
        cell: ({ row }) => {
          const value = evidence(row.original);
          return value ? (
            <FieldSummary entity={value.entity} field={value.field} />
          ) : null;
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
          return value ? entityRoster[value.entity].singular : null;
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
          return value && !value.correctionAuthority ? (
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
              <span className="truncate">
                {value.correctionAuthority ? "Member correction" : value.model}
              </span>
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

/** A multiselect over one of `REFERENCE_ROSTERS`, read only when opened. */
function rosterFilterConfig(
  rosters: RuntimeFilterOptions,
  key: (typeof REFERENCE_ROSTERS)[number]["key"],
  placeholder: string,
): FilterConfig {
  const source = deferredFilterOptionSource(rosters[key]);
  return {
    placeholder,
    filterType: "multiselect",
    exclude: true,
    options: source?.options ?? [],
    ...deferredRosterControls(source),
  };
}

function statementColumns(
  queryClient: QueryClient,
  rosters: RuntimeFilterOptions,
  providerCategoryLabel: string,
) {
  const KIND_OPTIONS = kindOptions(queryClient);
  const evidence = (row: Row) =>
    row.family === "statement_transaction" ? row.evidence : null;
  const rosterFilter = (
    key: (typeof REFERENCE_ROSTERS)[number]["key"],
    placeholder: string,
  ) => rosterFilterConfig(rosters, key, placeholder);
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
          return value.merchant ?? value.rawDescription;
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
              {kindAgreement(queryClient, create).reason}
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
          row.original.family === "statement_transaction" ? (
            <StackedValue
              primary={
                columnText(row.original, "providerCategory") ?? "Unassigned"
              }
              secondary={humanize(row.original.evidence.source)}
            />
          ) : (
            <NoneValue />
          ),
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
    row.family === "recommendation" && !("kind" in row.evidence)
      ? row.evidence
      : null;
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
          return `${entityRoster[value.source.entityKind].singular} → ${entityRoster[value.target.entityKind].singular}`;
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

/** Rosters for the statement and transfer-pair reference filters, read only when opened. */
export const REFERENCE_ROSTERS = suggestionFilterDeclaration.filters.flatMap(
  (filter) =>
    filter.reference
      ? [{ key: filter.columnId, target: filter.reference }]
      : [],
);

export function viewColumns(
  queryClient: QueryClient,
  view: SuggestionView,
  rosters: RuntimeFilterOptions,
  providerCategoryLabel: string,
): CubbyColumnCollection<Row> {
  switch (view) {
    case "field":
      return fieldColumns();
    case "statement_transaction":
      return statementColumns(queryClient, rosters, providerCategoryLabel);
    case "recommendation":
      return recommendationColumns();
    case "transfer_pair":
      return transferPairColumns(rosters);
    default:
      return allColumns();
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
  transfer_pair: { account: false, merchant: false },
} satisfies Partial<Record<SuggestionView, Record<string, false>>>;
