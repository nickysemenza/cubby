import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import type { ListGroupSummary } from "@cubby/schemas/pagination";
import {
  type WorkAction,
  workExecutorOptions,
  workFamilyOptions,
  workQueueInput,
  workQueueList,
  type WorkQueueOut,
  type WorkQueueRow,
  type WorkQueueView,
  workRecordTypeOptions,
} from "@cubby/schemas/work-queue";
import { CURRENT_MEMBER_FILTER } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import type { z } from "zod";

import { verbBulkAction } from "~/entity/actions/action-verb-ui";
import { createDataQualityColumn } from "~/entity/display/list-field-renderers";
import { isBrowserRoutedEntity } from "~/entity/entities";
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
  createImageColumn,
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
import { WorkActions } from "~/entity/work-queue/work-actions";
import { ownerLabel, OwnerPill } from "~/entity/work-queue/work-queue-display";
import { AttentionInputStatus } from "~/features/project/attention-input-status";
import { workQueue } from "~/integrations/tanstack-query/domains/workQueue";
import { copyShortcodes } from "~/lib/clipboard";
import { formatCount } from "~/lib/number-format";
import type { BulkActionsConfig } from "~/ui/data-table/bulk-actions.types";
import { BulkActionBar } from "~/ui/data-table/bulk/bulk-action-bar";
import { tableMoneyTotals } from "~/ui/data-table/bulk/table-money";
import { textCellData } from "~/ui/data-table/cell-data";
import { countedGroupPage } from "~/ui/data-table/counted-group-page";
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
import {
  type ListQueryOptionsFn,
  type ListQueryResponse,
} from "~/ui/hooks/use-paginated-table-core";
import { Button } from "~/ui/primitives/button";

import {
  suggestionsSearch,
  workRowHref,
  WorkRowLink,
  workRowType,
} from "./work-row-link";

const route = getRouteApi("/_authenticated/work-queue");
const NO_GROUPS: NonNullable<QueueTablePage["meta"]["groups"]> = [];
const NO_REASONS: WorkQueueOut["meta"]["reasons"] = [];
type QueueInput = z.output<typeof workQueueInput>;
type QueueFilters = Omit<QueueInput, "pageIndex" | "pageSize" | "sort">;
// A work row is identified by its key, independently of its record.
type QueueTableRow = Omit<WorkQueueRow, "id"> & {
  id: string;
  recordId: WorkQueueRow["id"];
};
type QueueTablePage = Omit<WorkQueueOut, "items" | "meta"> & {
  items: QueueTableRow[];
  meta: ListQueryResponse<QueueTableRow>["meta"] &
    Pick<
      WorkQueueOut["meta"],
      | "viewCounts"
      | "reasons"
      | "incompleteProjectIds"
      | "incompleteDiagnosticSources"
    > & {
      /** Each section's declared group actions, by its raw key. */
      groupActions: Readonly<Record<string, readonly WorkAction[]>>;
    };
};
const helper = createCubbyColumnHelper<QueueTableRow>();
const PREVIEW_OPTIONS = { responsiveInspector: true };
/** Search and the saved view ride beside the list's declared filters. */
const FILTER_SPECS: readonly FilterSpecCore[] = [
  { columnId: "name", field: "query", urlKey: "query", kind: "text" },
  { columnId: "view", kind: "text" },
  ...workQueueList.specs,
];
const HIDDEN_COLUMNS = { family: false, date: false };
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
  const {
    pageIndex: _pageIndex,
    pageSize: _pageSize,
    sort: _sort,
    ...filters
  } = workQueueInput.parse(
    buildFiltersFromManifest(FILTER_SPECS, state.getColumnFilterValues),
  );
  return filters;
};
const queueQueryPlan: ListQueryOptionsFn<
  QueueFilters,
  QueueTableRow,
  QueueTablePage
> = ({ filters, pagination, sort }) => {
  const input = workQueueInput.parse({
    ...filters,
    ...pagination,
    sort: workQueueInput.shape.sort.safeParse(sort).data,
  });
  const options = workQueue.queue.queryOptions(input);
  return {
    queryKey: options.queryKey,
    meta: options.meta,
    execute: async (signal, consistency) => {
      const result = await workQueue.queue.call(input, { signal, consistency });
      const grouping = result.meta.groups
        ? countedGroupPage({
            groups: result.meta.groups,
            ids: result.items.map((row) => row.key),
            offset: result.meta.pageIndex * result.meta.pageSize,
            totalCount: result.meta.totalCount,
          })
        : {};
      return {
        ...result,
        meta: {
          ...result.meta,
          hasNextPage:
            (result.meta.pageIndex + 1) * result.meta.pageSize <
            result.meta.totalCount,
          groups: undefined,
          ...grouping,
          groupActions: Object.fromEntries(
            (result.meta.groups ?? []).map((group) => [
              group.key,
              group.actions,
            ]),
          ),
        },
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
const rowSource = (row: QueueTableRow): WorkQueueRow => ({
  ...row,
  id: row.recordId,
});

const TYPE_OPTIONS = [
  ...nullableSentinelOptions().map((option) => ({
    ...option,
    label: option.value === FILTER_NONE ? "Problem" : option.label,
  })),
  ...workRecordTypeOptions,
];
const OWNER_ROSTER: readonly DeferredEntityRoster[] = [
  { key: "owner", target: "ledgerParty" },
];
const multiselect = { filterType: "multiselect" as const, exclude: true };

const FILTER_FIELDS: readonly FilterBarField[] = [
  {
    key: "view",
    label: "View",
    type: "select",
    options: workQueueList.views.map(({ key, label }) => ({
      value: key,
      label,
    })),
  },
];

const GROUP_MENU = workQueueList.grouping.map((choice) => ({
  key: choice.key,
  columnId: choice.filter?.columnId ?? choice.key,
  label: choice.label,
  reason: choice.reason,
}));
/** A section's key is its filter's value; Owner sections have no filter. */
const sectionFilter = (
  choice: GroupConfig["choice"],
  group: ListGroupSummary,
) => {
  const key = group.path[0];
  if (!choice.filter || key === undefined) return undefined;
  if (key === FILTER_NONE && !choice.filter.noValue) return undefined;
  return { id: choice.filter.columnId, value: [key] };
};

/** The row's declared actions, then its own Open or Review. */
function WorkRowActions({ work }: { work: QueueTableRow }) {
  const source = rowSource(work);
  const suggestions = suggestionsSearch(source);
  const href = workRowHref(source);
  return (
    <span className="flex items-center justify-end gap-1">
      <WorkActions
        actions={work.actions}
        target={{ scope: "item", row: source }}
      />
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
  reasons: WorkQueueOut["meta"]["reasons"],
  ownerRoster: RuntimeFilterOptionSource | undefined,
) {
  const ownerOptions = deferredFilterOptionSource(ownerRoster);
  return createCubbyColumnCollection<QueueTableRow>((add) => {
    add(buildSelectColumn<QueueTableRow>());
    add(
      createImageColumn(helper, {
        rowEntity: (row) => row.entity ?? undefined,
      }),
    );
    add(
      helper.accessor((row) => row.entity ?? FILTER_NONE, {
        cell: (info) => workRowType(info.row.original) ?? "Problem",
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
            ...multiselect,
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
    add(createCurrencyColumn(helper, "amount", { header: "Amount" }));
    // Quality is stated after the page is read, so the server cannot sort it.
    createDataQualityColumn(helper).visit((column) =>
      add({ ...column, enableSorting: false }),
    );
    add(
      helper.accessor((row) => row.reasonKeys, {
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
            placeholder: "Filter reason",
            ...multiselect,
            options: [...reasons],
          },
        }),
      }),
    );
    add(
      helper.accessor((row) => row.owners.map((owner) => owner.id), {
        id: "owner",
        header: "Owner",
        size: 190,
        cell: (info) => <OwnerPill {...info.row.original} />,
        meta: attachCubbyColumnMeta<QueueTableRow>({
          mobile: { slot: "trailing", priority: 1, interactive: true },
          cellData: textCellData<QueueTableRow>("text", ownerLabel),
          filterConfig: {
            placeholder: "Filter owner",
            referenceEntity: "ledgerParty",
            ...multiselect,
            // Shared work lists every member, so Me matches it too; No
            // value is Unresolved.
            options: [
              ...nullableSentinelOptions(),
              { value: CURRENT_MEMBER_FILTER, label: "Me" },
              ...(ownerOptions?.options ?? []),
            ],
            ...deferredRosterControls(ownerOptions),
          },
        }),
      }),
    );
    add(
      createSelectColumn(helper, "executor", {
        header: "Executor",
        size: 120,
        options: workExecutorOptions,
        filterConfig: {
          placeholder: "Filter executor",
          ...multiselect,
          options: workExecutorOptions,
        },
      }),
    );
    add(
      createSelectColumn(helper, "family", {
        header: "Family",
        size: 130,
        options: workFamilyOptions,
        filterConfig: {
          placeholder: "Filter family",
          ...multiselect,
          options: workFamilyOptions,
        },
      }),
    );
    add(createPlainDateColumn(helper, "date", { header: "Date" }));
    add(
      helper.display({
        id: "actions",
        header: "",
        enableSorting: false,
        enableHiding: false,
        enableCellSelection: false,
        size: 160,
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
      <WorkQueueRoute />
    </Page>
  );
}

const PROBLEMS_VIEW = "problems";

function WorkQueueRoute() {
  const search = route.useSearch();
  return (
    <WorkQueue
      groupBy={
        search.group ?? (search.view === PROBLEMS_VIEW ? "reason" : undefined)
      }
    />
  );
}

/** Embedded attention groups use the same queries and canonical actions as the full queue. */
export function WorkQueue({
  scope: fixedScope,
  groupBy,
  label = "Work queue",
}: {
  scope?: QueueFilters;
  groupBy?: string;
  label?: string;
}) {
  const navigate = useNavigate();
  const embedded = fixedScope !== undefined;
  const [embeddedGroup, setEmbeddedGroup] = useState<string | undefined>(
    groupBy,
  );
  // Problems opens grouped by Reason, where its group actions (Delete all,
  // backfills, Open in list) live; `none` keeps an explicit ungrouping.
  const group = embedded ? embeddedGroup : groupBy;
  const inspection = useEntityPreview(undefined, PREVIEW_OPTIONS);
  const tableState = useTableState({
    initialSort: workQueueList.defaultSort.orderBy,
    initialSortDesc: workQueueList.defaultSort.direction === "desc",
    filterSpecs: FILTER_SPECS,
    urlSync: !embedded,
    readUrlState: !embedded,
    syncPaginationToUrl: false,
  });
  const activeGroup = workQueueList.grouping.find(
    (choice) => choice.key === group && !choice.reason,
  );
  const queueFilters = useCallback(
    (state: TableStateReturn) => ({
      ...buildQueueFilters(state),
      ...fixedScope,
      group: workQueueInput.shape.group.safeParse(activeGroup?.key).data,
    }),
    [activeGroup, fixedScope],
  );
  const list = useInfiniteTableList({
    queryOptions: queueQueryPlan,
    buildFilters: queueFilters,
    tableState,
  });
  const firstPage = list.pages?.[0];
  const reasons = firstPage?.meta.reasons ?? NO_REASONS;
  const ownerRoster = useDeferredEntityRosters(OWNER_ROSTER).owner;
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<QueueTableRow>((add) => {
        queueColumns(reasons, ownerRoster).visit((column) =>
          add({
            ...column,
            // The section owns these predicates; never offer a filter it would ignore.
            enableColumnFilter:
              embedded &&
              (column.id === "family" ||
                (fixedScope?.view === "human" && column.id === "executor"))
                ? false
                : column.enableColumnFilter,
          }),
        );
      }),
    [reasons, ownerRoster, embedded, fixedScope],
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
    (next: string | null) => {
      if (embedded) {
        setEmbeddedGroup(next ?? undefined);
        return;
      }
      void navigate({
        to: ".",
        search: (prev) => ({
          ...prev,
          group: next ?? (prev.view === PROBLEMS_VIEW ? "none" : undefined),
        }),
        replace: true,
      });
    },
    [navigate, embedded],
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
    filterFields: embedded ? [] : FILTER_FIELDS,
    scrollRestorationId: label,
    grouping: {
      choices: GROUP_MENU,
      active: activeGroup?.key ?? null,
      onChange: setGroup,
    },
  });
  const groups = firstPage?.meta.groups ?? NO_GROUPS;
  const groupActions = firstPage?.meta.groupActions;
  const { setColumnFilters } = tableState;
  const groupConfig = useMemo<GroupConfig | undefined>(
    () =>
      activeGroup
        ? {
            choice: activeGroup,
            groups,
            memberships: list.memberships ?? [],
            canFilter: (section) =>
              sectionFilter(activeGroup, section) !== undefined,
            onFilter: (section) => {
              const filter = sectionFilter(activeGroup, section);
              if (filter)
                setColumnFilters((previous) => [
                  ...previous.filter(({ id }) => id !== filter.id),
                  filter,
                ]);
            },
            header: (section) => {
              const key = section.path[0];
              const actions = key ? groupActions?.[key] : undefined;
              return actions?.length && key
                ? {
                    actions: (
                      <WorkActions
                        actions={actions}
                        target={{
                          scope: "group",
                          reason: key,
                          count: section.count,
                        }}
                      />
                    ),
                  }
                : {};
            },
          }
        : undefined,
    [activeGroup, groups, groupActions, list.memberships, setColumnFilters],
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
      if (list.totalCount !== undefined && all.length < list.totalCount)
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
    if (isInspectorOpen || embedded) return;
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
  }, [isInspectorOpen, navigate, embedded]);

  const isLoading = useHydratedLoading(list.isLoading);
  const isTransitioning = list.infiniteScroll.isTransitioning;
  const hasFilters = tableState.columnFilters.length > 0;
  const viewCounts = firstPage?.meta.viewCounts;
  const view = buildQueueFilters(tableState).view;
  const setView = (next: WorkQueueView | undefined) =>
    tableState.setColumnFilters((previous) => [
      ...previous.filter((filter) => filter.id !== "view"),
      ...(next ? [{ id: "view", value: next }] : []),
    ]);
  const tabsTarget = usePageWorkbenchTarget("tabs", !embedded);
  const PreviewSheet = inspection.PreviewSheet;

  const incompleteCount = firstPage?.meta.incompleteProjectIds?.length ?? 0;
  const incompleteDiagnostics = firstPage?.meta.incompleteDiagnosticSources;
  const diagnosticError = incompleteDiagnostics?.find(
    (source) => source.error,
  )?.error;
  return (
    <>
      <AttentionInputStatus count={incompleteCount} />
      {!!incompleteDiagnostics?.length && (
        <p className="text-sm text-muted-foreground">
          Diagnostic counts are unavailable or out of date for{" "}
          {countLabel(incompleteDiagnostics.length, "check")}. Counts include
          known findings only.
          {incompleteDiagnostics.some((source) => source.pending) &&
            " Updates are pending."}
          {diagnosticError && (
            <span className="block font-mono">{diagnosticError}</span>
          )}
        </p>
      )}
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
              ...workQueueList.views.map((tab) => ({
                key: tab.key,
                label: tab.label,
                count: viewCounts?.[tab.key],
                active: view === tab.key,
                onSelect: () => setView(tab.key),
              })),
            ]}
          />,
          tabsTarget,
        )}
      <RTable
        table={table}
        ariaLabel={label}
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
