import { dataCheckLabel } from "@cubby/schemas/data-quality";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  workQueueGapChecks,
  workQueueGapViews,
  workQueueHouseholdInput,
  workQueueKindSchema,
  workQueueSourceSchema,
  workQueueSortSchema,
  type workQueueOutSchema,
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
import { useQueries } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import type { z } from "zod";

import { verbBulkAction } from "~/entity/actions/action-verb-ui";
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
import { Page } from "~/entity/page/page";
import {
  createCurrencyColumn,
  createPlainDateColumn,
  createSelectColumn,
} from "~/entity/table/column-helpers";
import { SortMenu } from "~/entity/table/data-table-toolbar";
import { LedgerFilters } from "~/entity/table/ledger-filters";
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
import { cn } from "~/lib/utils";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { CurrencyValue } from "~/ui/common/currency-value";
import { BulkActionBar } from "~/ui/data-table/bulk-action-bar";
import type { BulkActionsConfig } from "~/ui/data-table/bulk-actions.types";
import { textCellData } from "~/ui/data-table/cell-data";
import { reconcileRowSelection } from "~/ui/data-table/row-selection";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyRow,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { tableMoneyTotals } from "~/ui/data-table/table-money";
import { useBulkActions } from "~/ui/data-table/use-bulk-actions";
import { useTableConfig } from "~/ui/data-table/use-table-config";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import {
  deferredFilterOptionSource,
  deferredRosterControls,
  type RuntimeFilterOptionSource,
} from "~/ui/hooks/filter-option-types";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { useInfiniteScrollSentinel } from "~/ui/hooks/use-infinite-scroll-sentinel";
import { useIsMobile } from "~/ui/hooks/use-mobile";
import { type ListQueryOptionsFn } from "~/ui/hooks/use-paginated-table-core";
import { PageHeader } from "~/ui/layout/page-header";
import { TableRowStepContext } from "~/ui/overlays/side-panel";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Skeleton } from "~/ui/primitives/skeleton";

import {
  suggestionsSearch,
  workRowHref,
  WorkRowLink,
  workRowType,
} from "./work-row-link";

const route = getRouteApi("/_authenticated/work-queue");
const EMPTY_MEMBERS: WorkQueueMember[] = [];
type QueueInput = z.infer<typeof workQueueHouseholdInput>;
type QueueView = NonNullable<QueueInput["view"]>;
type QueueFilters = Pick<
  QueueInput,
  | "query"
  | "waitingFor"
  | "waitingForPresence"
  | "source"
  | "kind"
  | "check"
  | "vendor"
  | "view"
>;
// A work row is identified by its reason, independently of its source record.
type QueueTableRow = Omit<WorkQueueRow, "id"> & {
  id: string;
  recordId: WorkQueueRow["id"];
};
type QueueTablePage = Omit<z.infer<typeof workQueueOutSchema>, "items"> & {
  items: QueueTableRow[];
};
const helper = createCubbyColumnHelper<QueueTableRow>();
const PREVIEW_OPTIONS = { responsiveInspector: true };
const FILTER_SPECS: readonly FilterSpecCore[] = [
  { columnId: "name", urlKey: "query", kind: "text" },
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
  return {
    query: parsed.query,
    waitingFor: parsed.waitingFor,
    waitingForPresence: parsed.waitingForPresence,
    source: parsed.source,
    kind: parsed.kind,
    check: parsed.check,
    vendor: parsed.vendor,
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

/** The queue's declared views, in triage order; "All" reads every view. */
const VIEW_TABS: readonly { view: QueueView | undefined; label: string }[] = [
  { view: undefined, label: "All" },
  { view: "review", label: "Review" },
  { view: "research", label: "Research" },
  { view: "waiting", label: "Waiting" },
  { view: "automatic", label: "Automatic" },
];

/**
 * The headless columns behind the queue's filters and sort: rows render as
 * decision rows, so these carry only filter, sort and label metadata.
 */
function queueColumns(
  members: WorkQueueMember[],
  vendorRoster: RuntimeFilterOptionSource | undefined,
) {
  const memberOptions = memberOptionsOf(members);
  const vendorOptions = deferredFilterOptionSource(vendorRoster);
  return createCubbyColumnCollection<QueueTableRow>((add) => {
    add(
      helper.accessor((row) => row.name, {
        id: "name",
        header: "Record",
        meta: attachCubbyColumnMeta<QueueTableRow>({
          cellData: textCellData<QueueTableRow>("text", (row) => row.name),
          filterConfig: { placeholder: "Search work", filterType: "text" },
        }),
      }),
    );
    add(
      helper.accessor((row) => row.entity, {
        id: "entity",
        header: "Type",
        meta: attachCubbyColumnMeta<QueueTableRow>({
          cellData: textCellData<QueueTableRow>("text", (row) =>
            row.entity ? entitySummary[row.entity].singular : "Problem",
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
    add(
      helper.accessor((row) => row.reason, {
        id: "reason",
        enableSorting: false,
        header: "Reason",
        meta: attachCubbyColumnMeta<QueueTableRow>({
          cellData: textCellData<QueueTableRow>("text", (row) => row.reason),
          filterConfig: {
            placeholder: "Filter check",
            filterType: "multiselect",
            options: CHECK_OPTIONS,
          },
        }),
      }),
    );
    add(
      helper.accessor((row) => row.nextAction, {
        id: "nextAction",
        header: "Next action",
        meta: attachCubbyColumnMeta<QueueTableRow>({
          cellData: textCellData<QueueTableRow>(
            "text",
            (row) => row.nextAction,
          ),
        }),
      }),
    );
    add(
      helper.accessor((row) => waitingForLabel(row.waitingFor), {
        id: "waitingFor",
        header: "Waiting for",
        meta: attachCubbyColumnMeta<QueueTableRow>({
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
      helper.accessor((row) => row.vendor?.name ?? null, {
        id: "vendor",
        header: "Vendor",
        meta: attachCubbyColumnMeta<QueueTableRow>({
          linksTo: "vendor",
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
  });
}

/** The queue projects canonical work; filters never write assignment or source state. */
export function WorkQueuePage() {
  return (
    <Page variant="bare" layout="full">
      <WorkQueue />
    </Page>
  );
}

/** Whether a click landed on a control that owns it, not on the row. */
const isControlTarget = (event: MouseEvent) =>
  event.target instanceof Element &&
  event.target.closest(
    "a, button, input, label, [role=checkbox], [role=dialog]",
  ) !== null;

function WorkQueue() {
  const navigate = useNavigate();
  const search = route.useSearch();
  const view = search.view;
  const isMobile = useIsMobile();
  const inspection = useEntityPreview(undefined, PREVIEW_OPTIONS);
  const tableState = useTableState({
    initialSort: "kind",
    initialSortDesc: false,
    filterSpecs: FILTER_SPECS,
    urlSync: true,
    syncPaginationToUrl: false,
  });
  const viewFilters = useCallback(
    (state: TableStateReturn) => ({ ...buildQueueFilters(state), view }),
    [view],
  );
  const list = useInfiniteTableList({
    queryOptions: queueQueryPlan,
    buildFilters: viewFilters,
    tableState,
  });
  const members = list.pages?.[0]?.members ?? EMPTY_MEMBERS;
  const memberOptions = useMemo(() => memberOptionsOf(members), [members]);
  const vendorRoster = useDeferredEntityRosters(VENDOR_ROSTER).vendor;
  const columns = useMemo(
    () => queueColumns(members, vendorRoster),
    [members, vendorRoster],
  );
  const selection = useBulkActions({ config: COPY_ACTIONS });
  const { clearSelection, onRowSelectionChange } = selection;
  const scope = JSON.stringify(viewFilters(tableState));
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
  const table = useTableConfig({
    data: list.data,
    columns,
    tableState,
    totalCount: list.data.length,
    getRowId: queueRowId,
    enableRowSelection: canSelect,
    rowSelection: selection.rowSelection,
    onRowSelectionChange: selection.onRowSelectionChange,
    scrollRestorationId: "work-queue",
  });
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
  const [cursor, setCursor] = useState<string | null>(null);
  const currentRowId = inspection.preview?.rowKey ?? cursor;
  const { inspectRow } = inspection;
  const openRow = useCallback(
    (row: CubbyRow<QueueTableRow>) => {
      setCursor(row.id);
      const suggestions = suggestionsSearch(rowSource(row.original));
      if (suggestions)
        void navigate({ to: "/suggestions", search: suggestions });
      else if (canPreview(row)) inspectRow(previewRow(row));
      else if (row.original.entity === "run" && row.original.recordId)
        void navigate({
          to: entities.run.routes.detail,
          params: entityDetailParams(row.original.recordId),
        });
      else if (workRowHref(rowSource(row.original)) === "/problems")
        void navigate({ to: "/problems" });
    },
    [inspectRow, navigate],
  );
  // J/K walk the loaded rows; an open inspector follows the current row.
  const step = useCallback(
    (direction: -1 | 1) => {
      const index = rows.findIndex((row) => row.id === currentRowId);
      const next = rows[index === -1 ? 0 : index + direction];
      if (!next) return false;
      setCursor(next.id);
      if (inspection.isInspectorOpen && canPreview(next))
        inspectRow(previewRow(next));
      document
        .querySelector(`[data-work-row="${CSS.escape(next.id)}"]`)
        ?.scrollIntoView({ block: "nearest" });
      return true;
    },
    [rows, currentRowId, inspection.isInspectorOpen, inspectRow],
  );
  const stepRef = useRef(step);
  stepRef.current = step;
  const currentHref = (() => {
    const row = rows.find((candidate) => candidate.id === currentRowId);
    return row ? workRowHref(rowSource(row.original)) : undefined;
  })();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.target instanceof Element &&
          event.target.closest(
            "input, textarea, select, [contenteditable], [role=combobox], [role=listbox], [role=menu], [role=dialog]",
          ))
      )
        return;
      const key = event.key.toLowerCase();
      if (key === "j" || key === "k") {
        event.preventDefault();
        stepRef.current(key === "j" ? 1 : -1);
      } else if (event.key === "Enter" && currentHref) {
        // Enter opens the current row's full page, as a row link would.
        if (
          event.target instanceof Element &&
          event.target.closest("a, button")
        )
          return;
        event.preventDefault();
        void navigate({ to: currentHref });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [currentHref, navigate]);

  const tabCounts = useViewCounts(buildQueueFilters(tableState));
  const sentinelRef = useInfiniteScrollSentinel(list.infiniteScroll, "600px");
  const isLoading = useHydratedLoading(list.isLoading);
  const isTransitioning = list.infiniteScroll.isTransitioning;
  const hasFilters = tableState.columnFilters.length > 0;
  const loadedSelectable = rows.filter((row) => row.getCanSelect());
  const allSelected =
    loadedSelectable.length > 0 &&
    loadedSelectable.every((row) => row.getIsSelected());
  const someSelected = loadedSelectable.some((row) => row.getIsSelected());
  const docked = inspection.dockedInspector != null;
  const PreviewSheet = inspection.PreviewSheet;

  const setView = (next: QueueView | undefined) => {
    tableState.setPagination({
      pageIndex: 0,
      pageSize: tableState.pagination.pageSize,
    });
    void navigate({
      to: ".",
      search: (prev) => ({ ...prev, view: next }),
      replace: true,
    });
  };

  return (
    <div
      className={cn(
        "min-w-0",
        docked &&
          "xl:grid xl:grid-cols-[minmax(0,1fr)_var(--side-panel-width)]",
      )}
    >
      <div className="min-w-0 px-2 pt-3 pb-24 md:px-6">
        <PageHeader
          layout="inline"
          title="Work queue"
          tools={
            isMobile ? (
              <LedgerFilters table={table} variant="mobile" />
            ) : (
              <LedgerFilters table={table} />
            )
          }
          actions={
            <>
              {!isMobile && <SortMenu table={table} />}
              {/* An open inspector carries its own Close. */}
              {!inspection.isInspectorOpen && inspection.inspectorToggle}
            </>
          }
        />
        <div className="mt-2.5 flex min-w-0 items-end justify-between gap-3 border-b border-border">
          <div className="flex min-w-0 items-end gap-3">
            <span className="flex h-8 shrink-0 items-center">
              <Checkbox
                aria-label="Select all"
                checked={allSelected}
                indeterminate={someSelected && !allSelected}
                disabled={loadedSelectable.length === 0 || isTransitioning}
                onCheckedChange={(checked) =>
                  table.setRowSelection(
                    checked
                      ? Object.fromEntries(
                          loadedSelectable.map((row) => [row.id, true]),
                        )
                      : {},
                  )
                }
              />
            </span>
            <nav
              aria-label="Work views"
              className="flex min-w-0 [scrollbar-width:none] items-end gap-3 overflow-x-auto overscroll-x-contain"
            >
              {VIEW_TABS.map((tab) => {
                const active = tab.view === view;
                const count = tabCounts.get(tab.view ?? "all");
                return (
                  <button
                    key={tab.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setView(tab.view)}
                    className={cn(
                      "-mb-px flex shrink-0 items-baseline gap-1 border-b-2 pb-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:items-center",
                      active
                        ? "border-foreground-strong font-semibold text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tab.label}
                    <span
                      className={cn(
                        "font-mono text-xs font-normal tabular-nums",
                        active && "text-muted-foreground",
                      )}
                    >
                      {count === undefined ? "" : formatCount(count)}
                    </span>
                  </button>
                );
              })}
            </nav>
          </div>
          <p
            aria-hidden
            className="hidden shrink-0 pb-2 text-xs text-muted-foreground md:block"
          >
            <kbd className="font-mono">J</kbd>/
            <kbd className="font-mono">K</kbd> move ·{" "}
            <kbd className="font-mono">Enter</kbd> open
          </p>
        </div>

        {list.error && list.data.length === 0 ? (
          <ErrorDisplay
            error={list.error}
            title="the work queue"
            onRetry={() => void list.refreshControls?.onRefresh()}
            className="mt-4"
          />
        ) : isLoading ? (
          <output aria-label="Loading work" className="block">
            {Array.from({ length: 6 }, (_, index) => (
              <span
                key={index}
                className="block space-y-1.5 border-b border-border py-2.5"
              >
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-3.5 w-3/5" />
              </span>
            ))}
          </output>
        ) : rows.length === 0 ? (
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
        ) : (
          <ul
            aria-label="Work queue"
            aria-busy={isTransitioning || undefined}
            inert={isTransitioning ? true : undefined}
            className={cn("isolate", isTransitioning && "opacity-60")}
          >
            {rows.map((row) => (
              <DecisionRow
                key={row.id}
                row={row}
                current={row.id === currentRowId}
                memberOptions={memberOptions}
                onOpen={openRow}
                onHover={inspection.onRowHover}
                onHoverEnd={inspection.onRowHoverEnd}
              />
            ))}
          </ul>
        )}
        <div ref={sentinelRef} aria-hidden className="h-px" />
        {list.infiniteScroll.isFetchingNextPage && (
          <p className="py-3 text-center text-xs text-muted-foreground">
            Loading more work…
          </p>
        )}
      </div>
      {docked ? (
        <div
          data-desktop-inspector
          className="sticky top-(--app-chrome-top) hidden h-[calc(100dvh-var(--app-chrome-top)-var(--app-chrome-bottom))] overflow-y-auto border-l border-border bg-card xl:block"
        >
          <TableRowStepContext.Provider value={step}>
            {inspection.dockedInspector}
          </TableRowStepContext.Provider>
        </div>
      ) : null}
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
      <PreviewSheet />
    </div>
  );
}

/**
 * Each view's count under the current filters: the queue's own total for
 * that view, read one row deep so no tab's figure is a client estimate.
 */
function useViewCounts(filters: QueueFilters) {
  const results = useQueries({
    queries: VIEW_TABS.map((tab) =>
      workQueue.list.queryOptions(
        workQueueHouseholdInput.parse({
          ...filters,
          view: tab.view,
          pageSize: 1,
        }),
      ),
    ),
  });
  return new Map(
    VIEW_TABS.map((tab, index) => [
      tab.view ?? "all",
      results[index]?.data?.meta.totalCount,
    ]),
  );
}

const ROW_ACTION = "max-md:min-h-11";

/**
 * One piece of work: the record and its money or routing on the first line,
 * why it is here and what to do next beneath, with its own Open or Review.
 * Clicking the row inspects the record; its controls act on their own.
 */
function DecisionRow({
  row,
  current,
  memberOptions,
  onOpen,
  onHover,
  onHoverEnd,
}: {
  row: CubbyRow<QueueTableRow>;
  current: boolean;
  memberOptions: PickerOption[];
  onOpen: (row: CubbyRow<QueueTableRow>) => void;
  onHover: (row: ReturnType<typeof previewRow>) => void;
  onHoverEnd: (row: ReturnType<typeof previewRow>) => void;
}) {
  const work = row.original;
  const source = rowSource(work);
  const type = workRowType(work);
  const suggestions = suggestionsSearch(source);
  const href = workRowHref(source);
  const selectable = row.getCanSelect();
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- J/K and Enter are the row's keyboard path; its link and buttons carry the same actions.
    <li
      data-work-row={row.id}
      aria-current={current || undefined}
      onClick={(event) => {
        if (!isControlTarget(event)) onOpen(row);
      }}
      onMouseEnter={() => canPreview(row) && onHover(previewRow(row))}
      onMouseLeave={() => canPreview(row) && onHoverEnd(previewRow(row))}
      className={cn(
        "relative flex min-w-0 cursor-default gap-2 border-b border-border py-2 text-sm",
        "before:pointer-events-none before:absolute before:-inset-x-1.5 before:inset-y-0 before:-z-10 hover:before:bg-muted",
        current && "before:bg-(--row-current) hover:before:bg-(--row-current)",
      )}
    >
      <span className="flex h-4.5 w-4 shrink-0 items-center">
        {selectable ? (
          <Checkbox
            aria-label="Select row"
            checked={row.getIsSelected()}
            onCheckedChange={(checked) => row.toggleSelected(checked)}
          />
        ) : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="flex min-w-0 items-baseline gap-1">
            {type && <span className="shrink-0">{type}</span>}
            <WorkRowLink row={source} />
            {work.vendor && work.vendor.name !== work.name && (
              <span className="min-w-0 truncate text-muted-foreground">
                ·{" "}
                <Link
                  to={entities.vendor.routes.detail}
                  params={entityDetailParams(work.vendor.id)}
                  className="underline-offset-2 hover:text-foreground hover:underline"
                >
                  {work.vendor.name}
                </Link>
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {work.amount !== null && (
              <CurrencyValue
                value={work.amount}
                className="font-mono text-foreground-strong"
              />
            )}
            <WaitingForPill
              waitingFor={work.waitingFor}
              memberOptions={memberOptions}
            />
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 flex-[1_1_16rem] text-xs/4.5 text-muted-foreground">
            {work.reason}
            {work.nextAction && work.nextAction !== work.reason && (
              <>
                <span aria-hidden> · </span>
                <span className="text-foreground">Next:</span> {work.nextAction}
              </>
            )}
          </p>
          <span className="flex shrink-0 items-center gap-1.5">
            <WorkActionDetails explanations={work.explanations} />
            {suggestions ? (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link to="/suggestions" search={suggestions} />}
                className={ROW_ACTION}
              >
                Review
              </Button>
            ) : href ? (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link to={href} />}
                className={ROW_ACTION}
              >
                Open
              </Button>
            ) : null}
          </span>
        </div>
      </div>
    </li>
  );
}
