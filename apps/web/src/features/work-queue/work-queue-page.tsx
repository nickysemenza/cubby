import { dataCheckLabel } from "@cubby/schemas/data-quality";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  workQueueGapChecks,
  workQueueGapViews,
  workQueueHouseholdInput,
  workQueueKindSchema,
  workQueueSourceSchema,
  workQueueSortSchema,
  type workQueueOutSchema,
  type WorkQueueGroup,
  type WorkQueueKind,
  type WorkQueueMember,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { CURRENT_MEMBER_FILTER, humanize } from "@cubby/shared";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import type { z } from "zod";

import { verbBulkAction } from "~/entity/actions/action-verb-ui";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import {
  buildFiltersFromManifest,
  type FilterSpecCore,
  nullableSentinelOptions,
} from "~/entity/filters";
import {
  type DeferredEntityRoster,
  useDeferredEntityRosters,
} from "~/entity/hooks/use-deferred-reference-filter-options";
import { useEntityPreview } from "~/entity/hooks/use-entity-preview";
import { useInfiniteTableList } from "~/entity/hooks/use-infinite-table-list";
import { Page, usePageWorkbenchTarget } from "~/entity/page/page";
import {
  createCurrencyColumn,
  createPlainDateColumn,
  createSelectColumn,
} from "~/entity/table/column-helpers";
import { GroupMenu } from "~/entity/table/data-table-toolbar";
import { ViewTabs } from "~/entity/table/data-table-views";
import RTable from "~/entity/table/table";
import {
  useTableState,
  type TableStateReturn,
} from "~/entity/table/use-table-state";
import {
  memberOptionsOf,
  WaitingForPill,
  waitingForLabel,
  WorkActionDetails,
} from "~/entity/work-queue/work-queue-display";
import { workQueue } from "~/integrations/tanstack-query/generated/catalog.gen";
import { copyShortcodes } from "~/lib/clipboard";
import { formatCount } from "~/lib/number-format";
import type { PickerOption } from "~/ui/combobox/picker-option";
import type { BulkActionsConfig } from "~/ui/data-table/bulk-actions.types";
import { BulkActionBar } from "~/ui/data-table/bulk/bulk-action-bar";
import { tableMoneyTotals } from "~/ui/data-table/bulk/table-money";
import { textCellData } from "~/ui/data-table/cell-data";
import type { FilterBarField } from "~/ui/data-table/filter-bar-core";
import {
  buildSelectColumn,
  reconcileRowSelection,
} from "~/ui/data-table/row-selection";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyRow,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useBulkActions } from "~/ui/data-table/use-bulk-actions";
import type { GroupConfig } from "~/ui/data-table/use-grouped-list";
import { useTableConfig } from "~/ui/data-table/use-table-config";
import { EmptyState } from "~/ui/feedback/empty-state";
import {
  deferredFilterOptionSource,
  deferredRosterControls,
  type RuntimeFilterOptionSource,
} from "~/ui/hooks/filter-option-types";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { type ListQueryOptionsFn } from "~/ui/hooks/use-paginated-table-core";
import { Button } from "~/ui/primitives/button";

import {
  suggestionsSearch,
  workRowHref,
  WorkRowLink,
  workRowType,
} from "./work-row-link";

const route = getRouteApi("/_authenticated/work-queue");
const EMPTY_MEMBERS: WorkQueueMember[] = [];
const NO_GROUPS: NonNullable<QueuePage["meta"]["groups"]> = [];
type QueueInput = z.infer<typeof workQueueHouseholdInput>;
type QueueView = NonNullable<QueueInput["view"]>;
type QueuePage = z.infer<typeof workQueueOutSchema>;
type QueueFilters = Pick<
  QueueInput,
  | "query"
  | "view"
  | "entity"
  | "waitingFor"
  | "waitingForPresence"
  | "source"
  | "kind"
  | "check"
  | "vendor"
  | "group"
>;
// A work row is identified by its reason, independently of its source record.
type QueueTableRow = Omit<WorkQueueRow, "id"> & {
  id: string;
  recordId: WorkQueueRow["id"];
};
type QueueTablePage = Omit<QueuePage, "items"> & {
  items: QueueTableRow[];
};
const helper = createCubbyColumnHelper<QueueTableRow>();
const PREVIEW_OPTIONS = { responsiveInspector: true };
const FILTER_SPECS: readonly FilterSpecCore[] = [
  { columnId: "name", urlKey: "query", kind: "text" },
  { columnId: "view", kind: "text" },
  { columnId: "entity", kind: "multiselect" },
  {
    columnId: "waitingFor",
    kind: "multiselect",
    currentMember: true,
    nullable: { field: "waitingForPresence", label: "waiting for" },
  },
  { columnId: "source", kind: "multiselect" },
  { columnId: "kind", kind: "multiselect" },
  { columnId: "reason", field: "check", urlKey: "check", kind: "multiselect" },
  { columnId: "vendor", kind: "multiselect" },
];
/** Next action, date, source and kind stay one Columns-menu toggle away. */
const HIDDEN_COLUMNS = {
  kind: false,
  nextAction: false,
  date: false,
  source: false,
};
const COPY_ACTIONS: BulkActionsConfig<QueueTableRow> = {
  actions: [
    verbBulkAction<QueueTableRow>("copyCodes", {
      id: "copy-shortcodes",
      preserveSelection: true,
      onExecute: async (rows) => ({
        success: await copyShortcodes([
          ...new Set(
            rows.flatMap(({ original }) =>
              original.recordId ? [original.recordId] : [],
            ),
          ),
        ]),
      }),
    }),
  ],
};
const buildQueueFilters = (state: TableStateReturn): QueueFilters => {
  const parsed = workQueueHouseholdInput.parse({
    ...buildFiltersFromManifest(FILTER_SPECS, state.getColumnFilterValues),
    query: state.getColumnFilter("name"),
  });
  const { query, view, entity, waitingFor, waitingForPresence } = parsed;
  const { source, kind, check, vendor } = parsed;
  return {
    query,
    view,
    entity,
    waitingFor,
    waitingForPresence,
    source,
    kind,
    check,
    vendor,
  };
};
const queueQueryPlan: ListQueryOptionsFn<
  QueueFilters,
  QueueTableRow,
  QueueTablePage
> = ({ filters, pagination, sort }) => {
  const input = workQueueHouseholdInput.parse({
    ...filters,
    ...pagination,
    sort: workQueueSortSchema.safeParse(sort).data,
  });
  const options = workQueue.list.queryOptions(input);
  return {
    queryKey: options.queryKey,
    meta: options.meta,
    execute: async (signal) => {
      const result = await workQueue.list.call(input, { signal });
      return {
        ...result,
        items: result.items.map((row) => ({
          ...row,
          recordId: row.id,
          id: row.key,
        })),
      };
    },
  };
};
const queueRowId = (row: QueueTableRow) => row.id;
const canSelect = (row: CubbyRow<QueueTableRow>) =>
  row.original.recordId !== null;
const previewRow = (row: CubbyRow<QueueTableRow>) => ({
  id: row.id,
  original: { id: row.original.recordId, entityKind: row.original.entity },
});
const canPreview = (row: CubbyRow<QueueTableRow>) =>
  row.original.recordId !== null &&
  row.original.entity !== null &&
  row.original.entity !== "run" &&
  isBrowserRoutedEntity(row.original.entity);
const rowSource = (row: QueueTableRow) => ({ ...row, id: row.recordId });

const KIND_ICONS = {
  research: <MagnifyingGlassIcon />,
  review: <EyeIcon />,
  repair: <WrenchIcon />,
  awaiting_posting: <ClockIcon />,
} satisfies Record<WorkQueueKind, ReactNode>;
const KIND_OPTIONS = workQueueKindSchema.options.map((value) => ({
  value,
  label: humanize(value),
  icon: KIND_ICONS[value],
}));
const SOURCE_OPTIONS = workQueueSourceSchema.options.map((value) => ({
  value,
  label: humanize(value),
}));
const TYPE_OPTIONS = shortcodeEntities.map((value) => ({
  value,
  label: entitySummary[value].singular,
}));

// The check filter offers exactly the checks a gap row can carry; the entity
// prefix disambiguates shared labels ("Category", "Name").
const CHECK_OPTIONS = workQueueGapViews.flatMap((gapView) =>
  workQueueGapChecks(gapView).map((check) => ({
    value: check,
    label: `${entitySummary[gapView.entity].singular} · ${dataCheckLabel[check]}`,
  })),
);
const VENDOR_ROSTER: readonly DeferredEntityRoster[] = [
  { key: "vendor", target: "vendor" },
];

/** The queue's views, in triage order; the tabs preset the View filter. */
const VIEWS: readonly { view: QueueView; label: string }[] = [
  { view: "review", label: "Review" },
  { view: "research", label: "Research" },
  { view: "waiting", label: "Waiting" },
  { view: "automatic", label: "Automatic" },
];
const FILTER_FIELDS: readonly FilterBarField[] = [
  {
    key: "view",
    label: "View",
    type: "select",
    options: VIEWS.map(({ view, label }) => ({ value: view, label })),
  },
];

/** Projected values the server sections by, ahead of the sort. */
const GROUPS = [
  { key: "recordType", columnId: "entity", label: "Type" },
  { key: "waitingFor", columnId: "waitingFor", label: "Waiting for" },
  { key: "nextAction", columnId: "nextAction", label: "Next action" },
] as const satisfies readonly {
  key: WorkQueueGroup;
  columnId: string;
  label: string;
}[];
const groupChoice = (
  group: (typeof GROUPS)[number],
): GroupConfig["choice"] => ({
  key: group.key,
  label: group.label,
  noValueLabel: "None",
  reason: null,
  value: { kind: "derived", options: null },
  filter: null,
  levels: 0,
  levelReason: `${group.label} is a flat section, not a hierarchy.`,
});

/** The row's own Open or Review, beside the rule's details. */
function WorkRowActions({ work }: { work: QueueTableRow }) {
  const source = rowSource(work);
  const suggestions = suggestionsSearch(source);
  const href = workRowHref(source);
  return (
    <span className="flex items-center justify-end gap-1">
      <WorkActionDetails explanations={work.explanations} />
      {suggestions ? (
        <Button
          variant="ghost"
          size="xs"
          nativeButton={false}
          render={<Link to="/suggestions" search={suggestions} />}
        >
          Review
        </Button>
      ) : href ? (
        <Button
          variant="ghost"
          size="xs"
          nativeButton={false}
          render={<Link to={href} />}
        >
          Open
        </Button>
      ) : null}
    </span>
  );
}

function queueColumns(
  memberOptions: PickerOption[],
  vendorRoster: RuntimeFilterOptionSource | undefined,
) {
  const vendorOptions = deferredFilterOptionSource(vendorRoster);
  return createCubbyColumnCollection<QueueTableRow>((add) => {
    add(buildSelectColumn<QueueTableRow>());
    add(
      helper.accessor((row) => workRowType(row) ?? "Problem", {
        id: "entity",
        header: "Type",
        size: 120,
        meta: attachCubbyColumnMeta<QueueTableRow>({
          mobile: { slot: "subtitle", priority: 0 },
          cellData: textCellData<QueueTableRow>(
            "text",
            (row) => workRowType(row) ?? "Problem",
          ),
          filterConfig: {
            placeholder: "Filter type",
            filterType: "multiselect",
            options: TYPE_OPTIONS,
          },
        }),
      }),
    );
    add(
      helper.accessor((row) => row.name, {
        id: "name",
        header: "Record",
        size: 280,
        cell: (info) => <WorkRowLink row={rowSource(info.row.original)} />,
        meta: attachCubbyColumnMeta<QueueTableRow>({
          entityColumnRole: "identity",
          mobile: { slot: "title", renderTitle: true, interactive: true },
          cellData: textCellData<QueueTableRow>("text", (row) => row.name),
          filterConfig: { placeholder: "Search work", filterType: "text" },
        }),
      }),
    );
    add(
      helper.accessor((row) => row.vendor?.name ?? null, {
        id: "vendor",
        header: "Vendor",
        size: 160,
        cell: (info) => {
          const vendor = info.row.original.vendor;
          return vendor ? (
            <EntityRefLink
              variant="table"
              to={entities.vendor.routes.detail}
              params={entityDetailParams(vendor.id)}
              title={vendor.name}
              className="truncate"
            >
              {vendor.name}
            </EntityRefLink>
          ) : null;
        },
        meta: attachCubbyColumnMeta<QueueTableRow>({
          linksTo: "vendor",
          mobile: { slot: "subtitle", priority: 1 },
          cellData: textCellData<QueueTableRow>(
            "text",
            (row) => row.vendor?.name ?? "",
          ),
          filterConfig: {
            placeholder: "Filter vendor",
            filterType: "multiselect",
            options: vendorOptions?.options ?? [],
            ...deferredRosterControls(vendorOptions),
          },
        }),
      }),
    );
    add(createCurrencyColumn(helper, "amount", { header: "Amount" }));
    add(
      helper.accessor((row) => row.reason, {
        id: "reason",
        enableSorting: false,
        header: "Reason",
        size: 360,
        cell: (info) => (
          <span className="block truncate" title={info.row.original.reason}>
            {info.row.original.reason}
          </span>
        ),
        meta: attachCubbyColumnMeta<QueueTableRow>({
          mobile: { slot: "meta", priority: 0 },
          cellData: textCellData<QueueTableRow>("text", (row) => row.reason),
          filterConfig: {
            label: "Check",
            placeholder: "Filter check",
            filterType: "multiselect",
            options: CHECK_OPTIONS,
          },
        }),
      }),
    );
    add(
      helper.accessor((row) => waitingForLabel(row.waitingFor), {
        id: "waitingFor",
        header: "Waiting for",
        size: 130,
        cell: (info) => (
          <WaitingForPill
            waitingFor={info.row.original.waitingFor}
            memberOptions={memberOptions}
          />
        ),
        meta: attachCubbyColumnMeta<QueueTableRow>({
          mobile: { slot: "trailing", priority: 1, interactive: true },
          cellData: textCellData<QueueTableRow>("text", (row) =>
            waitingForLabel(row.waitingFor),
          ),
          filterConfig: {
            placeholder: "Filter waiting for",
            filterType: "multiselect",
            // Me also matches Either work; No value is Unresolved.
            options: [
              ...nullableSentinelOptions(),
              { value: CURRENT_MEMBER_FILTER, label: "Me" },
              { value: "either", label: "Either" },
              ...memberOptions,
            ],
          },
        }),
      }),
    );
    add(
      helper.accessor((row) => row.nextAction, {
        id: "nextAction",
        header: "Next action",
        size: 320,
        meta: attachCubbyColumnMeta<QueueTableRow>({
          cellData: textCellData<QueueTableRow>(
            "text",
            (row) => row.nextAction,
          ),
        }),
      }),
    );
    add(
      createSelectColumn(helper, "kind", {
        header: "Kind",
        options: KIND_OPTIONS,
        filterConfig: {
          placeholder: "Filter kind",
          filterType: "multiselect",
          options: KIND_OPTIONS,
        },
      }),
    );
    add(createPlainDateColumn(helper, "date", { header: "Date" }));
    add(
      createSelectColumn(helper, "source", {
        header: "Source",
        options: SOURCE_OPTIONS,
        filterConfig: {
          placeholder: "Filter source",
          filterType: "multiselect",
          options: SOURCE_OPTIONS,
        },
      }),
    );
    add(
      helper.display({
        id: "actions",
        header: "",
        enableSorting: false,
        enableHiding: false,
        enableCellSelection: false,
        size: 132,
        cell: (info) => <WorkRowActions work={info.row.original} />,
        meta: {
          entityColumnRole: "action",
          mobile: { slot: "actions", priority: 100, interactive: true },
        },
      }),
    );
  });
}

/** The queue projects canonical work; filters never write assignment or source state. */
export function WorkQueuePage() {
  return (
    <Page title="Work queue" listChrome="workbench" layout="full">
      <WorkQueue />
    </Page>
  );
}

function WorkQueue() {
  const navigate = useNavigate();
  const search = route.useSearch();
  const group = search.group;
  const inspection = useEntityPreview(undefined, PREVIEW_OPTIONS);
  const tableState = useTableState({
    initialSort: "kind",
    initialSortDesc: false,
    filterSpecs: FILTER_SPECS,
    urlSync: true,
    syncPaginationToUrl: false,
  });
  const queueFilters = useCallback(
    (state: TableStateReturn) => ({ ...buildQueueFilters(state), group }),
    [group],
  );
  const list = useInfiniteTableList({
    queryOptions: queueQueryPlan,
    buildFilters: queueFilters,
    tableState,
  });
  const firstPage = list.pages?.[0];
  const members = firstPage?.members ?? EMPTY_MEMBERS;
  const memberOptions = useMemo(() => memberOptionsOf(members), [members]);
  const vendorRoster = useDeferredEntityRosters(VENDOR_ROSTER).vendor;
  const columns = useMemo(
    () => queueColumns(memberOptions, vendorRoster),
    [memberOptions, vendorRoster],
  );
  const selection = useBulkActions({ config: COPY_ACTIONS });
  const { clearSelection, onRowSelectionChange } = selection;
  const scope = JSON.stringify(queueFilters(tableState));
  const queryScope = JSON.stringify([scope, tableState.sorting]);
  const activeQueryScope = useRef(queryScope);
  activeQueryScope.current = queryScope;
  const previousScope = useRef(scope);
  useEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope;
    clearSelection();
  }, [scope, clearSelection]);
  const availableRowIds = useMemo(
    () =>
      new Set(
        list.data.filter((row) => row.recordId !== null).map((row) => row.id),
      ),
    [list.data],
  );
  useEffect(() => {
    if (list.infiniteScroll.isTransitioning) return;
    onRowSelectionChange((current) =>
      reconcileRowSelection(current, availableRowIds),
    );
  }, [
    availableRowIds,
    list.infiniteScroll.isTransitioning,
    onRowSelectionChange,
  ]);
  const setGroup = useCallback(
    (next: string | null) =>
      void navigate({
        to: ".",
        search: (prev) => ({
          ...prev,
          group: GROUPS.find((choice) => choice.key === next)?.key,
        }),
        replace: true,
      }),
    [navigate],
  );
  const table = useTableConfig({
    data: list.data,
    columns,
    tableState,
    totalCount: list.data.length,
    getRowId: queueRowId,
    enableRowSelection: canSelect,
    rowSelection: selection.rowSelection,
    onRowSelectionChange: selection.onRowSelectionChange,
    initialColumnVisibility: HIDDEN_COLUMNS,
    filterFields: FILTER_FIELDS,
    scrollRestorationId: "work-queue",
    grouping: { choices: GROUPS, active: group ?? null, onChange: setGroup },
  });
  const groups = firstPage?.meta.groups ?? NO_GROUPS;
  const activeGroup = GROUPS.find((choice) => choice.key === group);
  const groupConfig = useMemo<GroupConfig | undefined>(
    () =>
      activeGroup ? { choice: groupChoice(activeGroup), groups } : undefined,
    [activeGroup, groups],
  );
  const rows = table.getRowModel().rows;
  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const [isSelectingAll, setIsSelectingAll] = useState(false);
  const selectAllMatching = useCallback(async () => {
    setIsSelectingAll(true);
    try {
      const all = await list.infiniteScroll.loadAllPages();
      if (activeQueryScope.current !== queryScope) return;
      table.setRowSelection(
        Object.fromEntries(
          all
            .filter((row) => row.recordId !== null)
            .map((row) => [row.id, true]),
        ),
      );
      if (all.length < list.totalCount)
        toast.warning(
          `Selected the first ${formatCount(all.length)} of ${formatCount(list.totalCount)} — too many to select at once. Narrow the filters to cover the rest.`,
        );
    } finally {
      setIsSelectingAll(false);
    }
  }, [list.infiniteScroll, list.totalCount, queryScope, table]);

  // The current row: the inspected record, else the row J/K last reached.
  // Clicking inspects; rows without a record open through their own link.
  const [cursor, setCursor] = useState<string | null>(null);
  const currentRowId = inspection.preview?.rowKey ?? cursor ?? undefined;
  const { inspectRow, isInspectorOpen } = inspection;
  const selectRow = useCallback(
    (row: CubbyRow<QueueTableRow>) => {
      setCursor(row.id);
      if (canPreview(row)) inspectRow(previewRow(row));
    },
    [inspectRow],
  );
  const currentHref = (() => {
    const row = rows.find((candidate) => candidate.id === currentRowId);
    return row ? workRowHref(rowSource(row.original)) : undefined;
  })();
  // J/K walk the loaded rows until the inspector opens and owns them;
  // Enter opens the current row's full page, as its link would.
  const keyState = useRef({ rows, currentRowId, currentHref });
  keyState.current = { rows, currentRowId, currentHref };
  useEffect(() => {
    if (isInspectorOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.target instanceof Element &&
          event.target.closest(
            "a, button, input, textarea, select, [contenteditable], [role=combobox], [role=listbox], [role=menu], [role=dialog]",
          ))
      )
        return;
      const state = keyState.current;
      const key = event.key.toLowerCase();
      if (key === "j" || key === "k") {
        event.preventDefault();
        const index = state.rows.findIndex(
          (row) => row.id === state.currentRowId,
        );
        const next =
          state.rows[index === -1 ? 0 : index + (key === "j" ? 1 : -1)];
        if (!next) return;
        setCursor(next.id);
        requestAnimationFrame(() =>
          document
            .querySelector("tr.table-record-row[data-current='true']")
            ?.scrollIntoView({ block: "nearest" }),
        );
      } else if (event.key === "Enter" && state.currentHref) {
        event.preventDefault();
        void navigate({ to: state.currentHref });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isInspectorOpen, navigate]);

  const isLoading = useHydratedLoading(list.isLoading);
  const isTransitioning = list.infiniteScroll.isTransitioning;
  const hasFilters = tableState.columnFilters.length > 0;
  const viewCounts = firstPage?.meta.viewCounts;
  const view = buildQueueFilters(tableState).view;
  const setView = (next: QueueView | undefined) =>
    tableState.setColumnFilters((previous) => [
      ...previous.filter((filter) => filter.id !== "view"),
      ...(next ? [{ id: "view", value: next }] : []),
    ]);
  const tabsTarget = usePageWorkbenchTarget("tabs");
  const PreviewSheet = inspection.PreviewSheet;

  return (
    <>
      {tabsTarget &&
        createPortal(
          <ViewTabs
            label="Work views"
            tabs={[
              {
                key: "all",
                label: "All",
                count: viewCounts?.all,
                active: view === undefined,
                onSelect: () => setView(undefined),
              },
              ...VIEWS.map((tab) => ({
                key: tab.view,
                label: tab.label,
                count: viewCounts?.[tab.view],
                active: view === tab.view,
                onSelect: () => setView(tab.view),
              })),
            ]}
          />,
          tabsTarget,
        )}
      <RTable
        table={table}
        ariaLabel="Work queue"
        isLoading={isLoading}
        error={list.error}
        infiniteScroll={list.infiniteScroll}
        refreshControls={list.refreshControls}
        groupConfig={groupConfig}
        actions={<GroupMenu table={table} />}
        inspectorToggle={isInspectorOpen ? null : inspection.inspectorToggle}
        desktopInspector={inspection.dockedInspector}
        currentRowId={currentRowId}
        onRowClick={selectRow}
        onRowHover={(row) =>
          canPreview(row) && inspection.onRowHover(previewRow(row))
        }
        onRowHoverEnd={(row) =>
          canPreview(row) && inspection.onRowHoverEnd(previewRow(row))
        }
        getMobileDetailsHref={(row) => workRowHref(rowSource(row))}
        bulkActionBar={
          <BulkActionBar
            selectedCount={selectedRows.length}
            selectedRows={selectedRows}
            moneyTotals={tableMoneyTotals(
              table.getVisibleLeafColumns(),
              selectedRows,
            )}
            actions={selection.getAvailableActions(selectedRows)}
            onExecute={selection.executeAction}
            onClearSelection={clearSelection}
            isExecuting={selection.isExecuting}
            currentAction={selection.currentAction}
            disabled={isTransitioning}
            selectAllMatching={{
              totalCount: list.totalCount,
              loadedCount: list.data.length,
              onSelectAll: selectAllMatching,
              isSelectingAll,
            }}
          />
        }
        emptyState={
          <EmptyState
            size="page"
            icon={TrayIcon}
            className="py-10"
            action={
              hasFilters ? (
                <Button
                  variant="outline"
                  onClick={() => table.resetColumnFilters()}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          >
            {hasFilters ? "No work matches these filters." : "Nothing here."}
          </EmptyState>
        }
      />
      <PreviewSheet />
    </>
  );
}
