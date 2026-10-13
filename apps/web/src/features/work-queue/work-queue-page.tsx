import { dataCheckLabel } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
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
import { humanize } from "@cubby/shared";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type { z } from "zod";

import { verbBulkAction } from "~/entity/actions/action-verb-ui";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  EntityIcon,
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { type FilterSpecCore } from "~/entity/filters";
import {
  GapChipCluster,
  memberOptionsOf,
  WaitingForPill,
  waitingForLabel,
} from "~/features/work-queue/work-queue-display";
import { workQueue } from "~/integrations/tanstack-query/generated/catalog.gen";
import { copyShortcodes } from "~/lib/clipboard";
import { formatCount } from "~/lib/utils";
import {
  bulkActionPreview,
  type BulkActionsConfig,
} from "~/ui/data-table/bulk-actions.types";
import { BulkActionBar } from "~/ui/data-table/BulkActionBar";
import { selectCellData, textCellData } from "~/ui/data-table/cell-data";
import {
  createCurrencyColumn,
  createImageColumn,
  createPlainDateColumn,
  renderOptionCell,
} from "~/ui/data-table/columnHelpers";
import {
  buildSelectColumn,
  reconcileRowSelection,
} from "~/ui/data-table/row-selection";
import RTable from "~/ui/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyRow,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useBulkActions } from "~/ui/data-table/useBulkActions";
import { useTableConfig } from "~/ui/data-table/useTableConfig";
import {
  useTableState,
  type TableStateReturn,
} from "~/ui/data-table/useTableState";
import {
  deferredFilterOptionSource,
  type RuntimeFilterOptionSource,
} from "~/ui/hooks/filter-option-types";
import {
  type DeferredEntityRoster,
  useDeferredEntityRosters,
} from "~/ui/hooks/useDeferredReferenceFilterOptions";
import { useEntityPreview } from "~/ui/hooks/useEntityPreview";
import { useHydratedLoading } from "~/ui/hooks/useHydrated";
import { useInfiniteTableList } from "~/ui/hooks/useInfiniteTableList";
import { type ListQueryOptionsFn } from "~/ui/hooks/usePaginatedTableCore";
import {
  domainForEntity,
  domainWayfinding,
} from "~/ui/navigation/domain-wayfinding";
import { Page, usePageCount } from "~/ui/page/Page";
import { NoneValue } from "~/ui/primitives/none-value";

const EMPTY_MEMBERS: WorkQueueMember[] = [];
const INITIAL_VISIBILITY = { nextAction: false };
type QueueInput = z.infer<typeof workQueueHouseholdInput>;
type QueueFilters = Pick<
  QueueInput,
  "query" | "waitingFor" | "source" | "kind" | "check" | "vendor"
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
const INITIAL_PAGINATION = { pageIndex: 0, pageSize: 25 };
const PREVIEW_OPTIONS = { responsiveInspector: true };
const FILTER_SPECS: readonly FilterSpecCore[] = [
  { columnId: "name", urlKey: "query", kind: "text" },
  { columnId: "waitingFor", kind: "select" },
  { columnId: "source", kind: "select" },
  { columnId: "kind", kind: "select" },
  { columnId: "reason", urlKey: "check", kind: "multiselect" },
  { columnId: "vendor", kind: "select" },
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
    query: state.getColumnFilter("name"),
    waitingFor: state.getColumnFilter("waitingFor"),
    source: state.getColumnFilter("source"),
    kind: state.getColumnFilter("kind"),
    check: state.getColumnFilterValues("reason"),
    vendor: state.getColumnFilter("vendor"),
  });
  return {
    query: parsed.query,
    waitingFor: parsed.waitingFor,
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

const KIND_ICONS = {
  research: <MagnifyingGlassIcon />,
  review: <EyeIcon />,
  repair: <WrenchIcon />,
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

function entityTypeOption(entity: Entity) {
  const domain = domainForEntity(entity);
  return {
    value: entity,
    label: entitySummary[entity].singular,
    icon: <EntityIcon entity={entity} />,
    color: domain ? `var(${domainWayfinding(domain).accentToken})` : undefined,
  };
}

/** A suggested field opens the AI Review list filtered to it. */
function suggestionReviewHref(row: QueueTableRow) {
  if (row.entity === null || row.suggestionField === undefined) return null;
  const search = new URLSearchParams({
    tab: "review",
    entity: row.entity,
    field: row.suggestionField,
  });
  return `/ai?${search.toString()}`;
}

function queueHref(row: QueueTableRow) {
  const review = suggestionReviewHref(row);
  if (review) return review;
  // Run detail recovers pending execution on read (#1905); use passive Problems.
  if (row.entity === null || row.recordId === null || row.entity === "run")
    return "/problems";
  return isBrowserRoutedEntity(row.entity)
    ? `/${entities[row.entity].basePath}/${row.recordId}`
    : undefined;
}

function WorkRecordLink({ row }: { row: QueueTableRow }) {
  if (row.entity !== null && row.suggestionField !== undefined)
    return (
      <Link
        to="/ai"
        search={{
          tab: "review",
          entity: row.entity,
          field: row.suggestionField,
        }}
        className="block truncate font-medium"
      >
        {row.name}
      </Link>
    );
  if (row.entity === null || row.recordId === null || row.entity === "run") {
    return (
      <Link
        to="/problems"
        title={row.name}
        className="block truncate font-medium"
      >
        {row.name}
      </Link>
    );
  }
  return isBrowserRoutedEntity(row.entity) ? (
    <EntityRefLink
      variant="table"
      tone="identity"
      to={entities[row.entity].routes.detail}
      params={entityDetailParams(row.recordId)}
      title={row.name}
    >
      {row.name}
    </EntityRefLink>
  ) : (
    row.name
  );
}

function VendorLink({ vendor }: { vendor: QueueTableRow["vendor"] }) {
  if (!vendor) return <NoneValue />;
  return (
    <EntityRefLink
      variant="table"
      tone="identity"
      to={entities.vendor.routes.detail}
      params={entityDetailParams(vendor.id)}
      title={vendor.name}
    >
      {vendor.name}
    </EntityRefLink>
  );
}

function queueColumns(
  members: WorkQueueMember[],
  vendorRoster: RuntimeFilterOptionSource | undefined,
) {
  const memberOptions = memberOptionsOf(members);
  const vendorOptions = deferredFilterOptionSource(vendorRoster);
  return createCubbyColumnCollection<QueueTableRow>((add) => {
    add(buildSelectColumn<QueueTableRow>());
    add(
      createImageColumn(helper, {
        rowEntity: (row) => row.entity ?? undefined,
      }),
    );
    add(
      helper.accessor((row) => row.name, {
        id: "name",
        header: "Record",
        size: 320,
        meta: attachCubbyColumnMeta<QueueTableRow>({
          entityColumnRole: "identity",
          mobile: { slot: "title" },
          cellData: textCellData<QueueTableRow>("text", (row) => row.name),
          filterConfig: { placeholder: "Search work", filterType: "text" },
        }),
        cell: ({ row }) => <WorkRecordLink row={row.original} />,
      }),
    );
    add(
      helper.accessor((row) => row.entity, {
        id: "entity",
        header: "Type",
        size: 128,
        meta: attachCubbyColumnMeta<QueueTableRow>({
          // Diagnostics have no entity but still render their Problem pill.
          mobile: {
            slot: "meta",
            priority: 1,
            label: "Type",
            showWhenEmpty: true,
          },
          cellData: textCellData<QueueTableRow>("text", (row) =>
            row.entity ? entitySummary[row.entity].singular : "Problem",
          ),
        }),
        cell: ({ row }) =>
          row.original.entity
            ? renderOptionCell(row.original.entity, [
                entityTypeOption(row.original.entity),
              ])
            : renderOptionCell("problem", [
                { value: "problem", label: "Problem" },
              ]),
      }),
    );
    add(
      helper.accessor((row) => row.kind, {
        id: "kind",
        header: "Kind",
        size: 112,
        meta: attachCubbyColumnMeta<QueueTableRow>({
          mobile: { slot: "meta", priority: 0, label: "Kind" },
          cellData: selectCellData<QueueTableRow>(
            (row) => row.kind,
            KIND_OPTIONS,
          ),
          filterConfig: {
            placeholder: "Filter kind",
            filterType: "select",
            options: KIND_OPTIONS,
          },
        }),
        cell: ({ row }) => renderOptionCell(row.original.kind, KIND_OPTIONS),
      }),
    );
    add(
      helper.accessor((row) => row.reason, {
        id: "reason",
        enableSorting: false,
        header: "Reason",
        // Two gap chips side by side need this much room; the generic
        // column floor squeezed them to one truncated chip and "+N".
        size: 400,
        minSize: 260,
        meta: attachCubbyColumnMeta<QueueTableRow>({
          mobile: { slot: "subtitle", priority: 0, label: "Reason" },
          cellData: textCellData<QueueTableRow>("text", (row) => row.reason),
          filterConfig: {
            placeholder: "Filter check",
            filterType: "multiselect",
            options: CHECK_OPTIONS,
          },
        }),
        // A gap row names each failed check; other rows keep their reason,
        // titled with the rule's next action (its column starts hidden
        // because it repeats for every row of one rule).
        cell: ({ row }) =>
          row.original.gaps.length > 0 ? (
            <GapChipCluster gaps={row.original.gaps} />
          ) : (
            <span className="block truncate" title={row.original.nextAction}>
              {row.original.reason}
            </span>
          ),
      }),
    );
    add(
      helper.accessor((row) => row.nextAction, {
        id: "nextAction",
        header: "Next action",
        size: 320,
        meta: attachCubbyColumnMeta<QueueTableRow>({
          mobile: { slot: "subtitle", priority: 1, label: "Next action" },
          cellData: textCellData<QueueTableRow>(
            "text",
            (row) => row.nextAction,
          ),
        }),
        cell: ({ row }) => (
          <span title={row.original.nextAction}>{row.original.nextAction}</span>
        ),
      }),
    );
    add(
      helper.accessor((row) => waitingForLabel(row.waitingFor), {
        id: "waitingFor",
        header: "Waiting for",
        size: 136,
        meta: attachCubbyColumnMeta<QueueTableRow>({
          mobile: { slot: "meta", priority: 2, label: "Waiting for" },
          cellData: textCellData<QueueTableRow>("text", (row) =>
            waitingForLabel(row.waitingFor),
          ),
          filterConfig: {
            placeholder: "Filter waiting for",
            filterType: "select",
            options: [
              { value: "me", label: "Me or Either" },
              { value: "either", label: "Either" },
              { value: "unresolved", label: "Unresolved" },
              ...memberOptions,
            ],
          },
        }),
        cell: ({ row }) => (
          <WaitingForPill
            waitingFor={row.original.waitingFor}
            memberOptions={memberOptions}
          />
        ),
      }),
    );
    add(
      helper.accessor((row) => row.vendor?.name ?? null, {
        id: "vendor",
        header: "Vendor",
        size: 160,
        meta: attachCubbyColumnMeta<QueueTableRow>({
          linksTo: "vendor",
          mobile: { slot: "meta", priority: 4, label: "Vendor" },
          cellData: textCellData<QueueTableRow>(
            "text",
            (row) => row.vendor?.name ?? "",
          ),
          filterConfig: {
            placeholder: "Filter vendor",
            filterType: "select",
            options: vendorOptions?.options ?? [],
            onActivate: vendorOptions?.onActivate,
            onSearchChange: vendorOptions?.onSearchChange,
            isLoading: vendorOptions?.isLoading,
          },
        }),
        cell: ({ row }) => <VendorLink vendor={row.original.vendor} />,
      }),
    );
    add(
      createCurrencyColumn(helper, "amount", {
        header: "Amount",
        signedTone: true,
        mobile: { slot: "trailing", priority: 0 },
      }),
    );
    add(
      createPlainDateColumn(helper, "date", {
        header: "Date",
        mobile: { slot: "meta", priority: 5, label: "Date" },
      }),
    );
    add(
      helper.accessor((row) => row.source, {
        id: "source",
        header: "Source",
        size: 144,
        meta: attachCubbyColumnMeta<QueueTableRow>({
          mobile: { slot: "meta", priority: 3, label: "Source" },
          cellData: selectCellData<QueueTableRow>(
            (row) => row.source,
            SOURCE_OPTIONS,
          ),
          filterConfig: {
            placeholder: "Filter source",
            filterType: "select",
            options: SOURCE_OPTIONS,
          },
        }),
        cell: ({ row }) =>
          renderOptionCell(row.original.source, SOURCE_OPTIONS),
      }),
    );
  });
}

/** The queue projects canonical work; filters never write assignment or source state. */
export function WorkQueuePage() {
  return (
    <Page
      variant="list"
      listChrome="workbench"
      title="Work queue"
      layout="full"
      bodyGutter="none"
    >
      <WorkQueueTable />
    </Page>
  );
}

function WorkQueueTable() {
  const navigate = useNavigate();
  const inspection = useEntityPreview(undefined, PREVIEW_OPTIONS);
  const tableState = useTableState({
    initialSort: "kind",
    initialSortDesc: false,
    initialPagination: INITIAL_PAGINATION,
    filterSpecs: FILTER_SPECS,
    urlSync: true,
    syncPaginationToUrl: false,
  });
  const list = useInfiniteTableList({
    queryOptions: queueQueryPlan,
    buildFilters: buildQueueFilters,
    tableState,
  });
  const members = list.pages?.[0]?.members ?? EMPTY_MEMBERS;
  const vendorRoster = useDeferredEntityRosters(VENDOR_ROSTER).vendor;
  const columns = useMemo(
    () => queueColumns(members, vendorRoster),
    [members, vendorRoster],
  );
  usePageCount(list.isLoading ? undefined : list.totalCount);
  const selection = useBulkActions({ config: COPY_ACTIONS });
  const { clearSelection, onRowSelectionChange } = selection;
  const {
    onRowClick: previewClick,
    onRowHover: previewHover,
    onRowHoverEnd: previewHoverEnd,
  } = inspection;
  const scope = JSON.stringify(buildQueueFilters(tableState));
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
    initialColumnVisibility: INITIAL_VISIBILITY,
    scrollRestorationId: "work-queue",
  });
  const [isSelectingAll, setIsSelectingAll] = useState(false);
  const selectAllMatching = useCallback(async () => {
    setIsSelectingAll(true);
    try {
      const rows = await list.infiniteScroll.loadAllPages();
      if (activeQueryScope.current !== queryScope) return;
      table.setRowSelection(
        Object.fromEntries(
          rows
            .filter((row) => row.recordId !== null)
            .map((row) => [row.id, true]),
        ),
      );
      if (rows.length < list.totalCount)
        toast.warning(
          `Selected the first ${formatCount(rows.length)} of ${formatCount(list.totalCount)} — too many to select at once. Narrow the filters to cover the rest.`,
        );
    } finally {
      setIsSelectingAll(false);
    }
  }, [list.infiniteScroll, list.totalCount, queryScope, table]);
  const onRowClick = useCallback(
    (row: CubbyRow<QueueTableRow>) => {
      const { entity, suggestionField } = row.original;
      if (canPreview(row)) previewClick(previewRow(row));
      else if (entity !== null && suggestionField !== undefined)
        void navigate({
          to: "/ai",
          search: { tab: "review", entity, field: suggestionField },
        });
      else if (queueHref(row.original) === "/problems")
        void navigate({ to: "/problems" });
    },
    [previewClick, navigate],
  );
  const onRowHover = useCallback(
    (row: CubbyRow<QueueTableRow>) => {
      if (canPreview(row)) previewHover(previewRow(row));
    },
    [previewHover],
  );
  const onRowHoverEnd = useCallback(
    (row: CubbyRow<QueueTableRow>) => {
      if (canPreview(row)) previewHoverEnd(previewRow(row));
    },
    [previewHoverEnd],
  );
  const PreviewSheet = inspection.PreviewSheet;
  const isLoading = useHydratedLoading(list.isLoading);
  return (
    <>
      <RTable
        table={table}
        ariaLabel="Work queue"
        isLoading={isLoading}
        error={list.error}
        infiniteScroll={list.infiniteScroll}
        refreshControls={list.refreshControls}
        bulkActionPreview={bulkActionPreview(COPY_ACTIONS)}
        bulkActionBar={
          <BulkActionBar
            selectedCount={selection.selectedCount}
            selectedRows={table.getFilteredSelectedRowModel().rows}
            actions={selection.getAvailableActions(
              table.getFilteredSelectedRowModel().rows,
            )}
            onExecute={selection.executeAction}
            onClearSelection={selection.clearSelection}
            isExecuting={selection.isExecuting}
            currentAction={selection.currentAction}
            disabled={list.infiniteScroll.isTransitioning}
            selectAllMatching={{
              totalCount: list.totalCount,
              loadedCount: list.data.length,
              onSelectAll: selectAllMatching,
              isSelectingAll,
            }}
          />
        }
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        onRowHoverEnd={onRowHoverEnd}
        currentRowId={inspection.preview?.rowKey}
        desktopInspector={inspection.dockedInspector}
        inspectorToggle={inspection.inspectorToggle}
        showColumnMenu
        getMobileDetailsHref={queueHref}
        emptyState="No work matches these filters."
      />
      <PreviewSheet />
    </>
  );
}
