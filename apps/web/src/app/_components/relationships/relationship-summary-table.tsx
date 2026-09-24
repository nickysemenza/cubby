import type {
  RelatedSummaryInput,
  RelatedSummaryOutput,
  RelatedSummaryRelationKey,
} from "@cubby/schemas/related-view";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import type {
  CellData,
  OnChangeFn,
  SortingState,
  Updater,
} from "@tanstack/react-table";
import { type FC, useCallback, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { ImageThumbnail } from "~/app/_components/table/ImageThumbnail";
import { VendorMark } from "~/components/entity/vendor-cell";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { relatedData } from "~/lib/related-data.functions";
import { formatCurrency } from "~/lib/utils";

import { useTableColumnLayout } from "../data-table/column-layout";
import { createCurrencyColumn } from "../data-table/columnHelpers";
import RTable from "../data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnDef,
  useCubbyTable,
} from "../data-table/table-features";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";

const PAGE_SIZE = 25;

/** Whatever the server can order these aggregates by — derived, never restated. */
type SortField = NonNullable<RelatedSummaryInput["sort"]>["field"];

type SummaryRow = RelatedSummaryOutput["data"][number];
/** `id` is what TanStack keys rows by, and what `InfiniteScrollControls` wants. */
type SummaryTableRow = SummaryRow & { id: string };

type Column =
  | "target"
  | "acquired"
  | "purchases"
  | "expenses"
  | "unpriced"
  | "items"
  | "sharedCharges"
  | "coverage"
  | "netSpend"
  | "latestActivity";

interface RelationshipSummaryTableProps {
  relationKey: RelatedSummaryRelationKey;
  sourceId: string;
  includeSubProjects?: boolean;
  columns: readonly Column[];
  defaultSort: { field: SortField; direction: "asc" | "desc" };
  emptyCopy: string;
  note?: string;
  nullLabel?: string;
  /** Exact ledger scope for one aggregate bucket. */
  expenseHref: (target: SummaryRow["target"]) => string;
  operations?: RelationshipSummaryOperations;
}

export interface RelationshipSummaryOperations {
  summary: typeof relatedData.summary;
}

const productionRelationshipSummaryOperations: RelationshipSummaryOperations = {
  summary: relatedData.summary,
};

const COLUMN_LABELS = {
  target: "Name",
  acquired: "Acquired",
  purchases: "Purchases",
  expenses: "Expenses",
  unpriced: "Unpriced",
  items: "Items",
  sharedCharges: "Shared charges",
  coverage: "Coverage",
  netSpend: "Net spend",
  latestActivity: "Latest",
} satisfies Record<Column, string>;

function columnForSort(field: SortField): Column {
  if (field === "target") return "target";
  if (field === "knownAcquiredUnits") return "acquired";
  if (field === "purchaseCount") return "purchases";
  if (field === "expenseCount") return "expenses";
  if (field === "netSpend") return "netSpend";
  return "latestActivity";
}

function sortFieldForColumn(column: string): SortField | undefined {
  if (column === "target") return "target";
  if (column === "acquired") return "knownAcquiredUnits";
  if (column === "purchases") return "purchaseCount";
  if (column === "expenses") return "expenseCount";
  if (column === "netSpend") return "netSpend";
  if (column === "latestActivity") return "latestActivity";
  return undefined;
}

function targetEntityForRelation(
  relationKey: RelatedSummaryRelationKey,
): NonNullable<SummaryRow["target"]>["entity"] {
  if (relationKey === "project.vendors" || relationKey === "product.vendors")
    return "vendor";
  if (relationKey === "vendor.projects" || relationKey === "purchase.projects")
    return "project";
  return "product";
}

function isSortingUpdater(
  updater: Updater<SortingState>,
): updater is (previous: SortingState) => SortingState {
  return typeof updater === "function";
}

function targetImage(
  target: SummaryRow["target"],
  fallbackEntity: NonNullable<SummaryRow["target"]>["entity"],
) {
  if (target?.entity === "vendor") {
    return (
      <div className="flex h-full items-center justify-center">
        <VendorMark
          vendor={target.label}
          vendorId={target.id}
          logo={target.image ? { url: target.image.url } : null}
        />
      </div>
    );
  }

  return (
    <ImageThumbnail
      images={target?.image ? [target.image] : []}
      alt={target ? `${target.label} image` : "No linked image"}
      lazyPreview
      entity={target?.entity ?? fallbackEntity}
    />
  );
}

/**
 * A dense, read-only aggregate table over one relationship.
 *
 * Rows are aggregates rather than entity records, so nothing here is
 * inline-editable, selectable, or deletable — but the presentation is the
 * canonical `RTable` like every other table in the app. Sorting, searching, and
 * paging stay on the SERVER (the grouped values can't be re-sorted correctly
 * from one loaded page), which is why the table is hand-wired with
 * `manualSorting`/`manualFiltering` and fed `RTable`'s `infiniteScroll` controls
 * instead of going through `useEntityList`.
 */
export const RelationshipSummaryTable: FC<RelationshipSummaryTableProps> = ({
  relationKey,
  sourceId,
  includeSubProjects,
  columns,
  defaultSort,
  emptyCopy,
  note,
  nullLabel = "Unassigned",
  expenseHref,
  operations = productionRelationshipSummaryOperations,
}) => {
  const targetEntity = targetEntityForRelation(relationKey);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState(defaultSort);

  const pageInput = useCallback(
    (offset: number) => ({
      relationKey,
      sourceId,
      includeSubProjects,
      search: search || undefined,
      sort,
      offset,
      limit: PAGE_SIZE,
    }),
    [relationKey, sourceId, includeSubProjects, search, sort],
  );

  const query = useInfiniteQuery({
    ...operations.summary.infiniteQueryOptions(pageInput(0), {
      initialPageParam: 0,
      pageParamSchema: z.number().int().nonnegative(),
      page: (input, offset) => ({ ...input, offset }),
      getNextPageParam: (page) => page.nextOffset ?? undefined,
    }),
    placeholderData: keepPreviousData,
  });

  const rows = useMemo<SummaryTableRow[]>(
    () =>
      (query.data?.pages ?? []).flatMap((page, pageIndex) =>
        page.data.map((row, index) => ({
          ...row,
          // The "Unassigned" bucket has no target, and one page can only ever
          // hold one of them — namespace it so a row id is still unique.
          id: row.target?.id ?? `unassigned-${pageIndex}-${index}`,
        })),
      ),
    [query.data],
  );
  // Every page carries the same full-set aggregates; the latest is the freshest.
  const summary = query.data?.pages.at(-1);

  const helper = useMemo(() => createCubbyColumnHelper<SummaryTableRow>(), []);

  // Every call site passes a fresh arrow / array literal. Column defs must not
  // churn on that: TanStack caches accessor results per row and only rebuilds
  // the row model when `data` changes, so a rebuilt column carrying a fresh
  // closure would still read stale cached values (see `createImageColumn`).
  const expenseHrefRef = useRef(expenseHref);
  expenseHrefRef.current = expenseHref;
  const columnsKey = columns.join(",");

  const tableColumns = useMemo(() => {
    const build = (
      column: Column,
      add: <TValue extends CellData>(
        definition: CubbyColumnDef<SummaryTableRow, TValue>,
      ) => void,
    ) => {
      switch (column) {
        case "target":
          add({
            ...helper.accessor((row) => row.target, {
              id: "target",
              header: COLUMN_LABELS.target,
              meta: { className: "min-w-0 w-48" },
              cell: (info) => {
                const target = info.getValue();
                if (!target) {
                  return (
                    <span className="font-medium text-warning-ink">
                      {nullLabel}
                    </span>
                  );
                }
                return (
                  <EntityInlineLink
                    entity={target.entity}
                    data={{ id: target.id, name: target.label }}
                    displayImage={
                      target.image ? { url: target.image.url } : null
                    }
                    showIdentityMark={false}
                    truncate
                  />
                );
              },
            }),
            enableSorting: sortFieldForColumn(column) !== undefined,
          });
          return;
        case "acquired":
          add({
            ...helper.accessor((row) => row.knownAcquiredUnits, {
              id: "acquired",
              header: COLUMN_LABELS.acquired,
              meta: { className: "w-20", numeric: true, mono: true },
              cell: (info) => (
                <span>
                  {info.getValue()}
                  {info.row.original.unknownAcquisitionQuantityCount > 0 && (
                    <span className="text-warning-ink">
                      {` +${info.row.original.unknownAcquisitionQuantityCount}?`}
                    </span>
                  )}
                </span>
              ),
            }),
            enableSorting: sortFieldForColumn(column) !== undefined,
          });
          return;
        case "purchases":
          add({
            ...helper.accessor((row) => row.purchaseCount, {
              id: "purchases",
              header: COLUMN_LABELS.purchases,
              meta: { className: "w-20", numeric: true, mono: true },
            }),
            enableSorting: sortFieldForColumn(column) !== undefined,
          });
          return;
        case "expenses":
          add({
            ...helper.accessor((row) => row.expenseCount, {
              id: "expenses",
              header: COLUMN_LABELS.expenses,
              meta: { className: "w-20", numeric: true, mono: true },
            }),
            enableSorting: sortFieldForColumn(column) !== undefined,
          });
          return;
        case "unpriced":
          add({
            ...helper.accessor((row) => row.unpricedExpenseCount, {
              id: "unpriced",
              header: COLUMN_LABELS.unpriced,
              meta: { className: "w-20", numeric: true, mono: true },
              // A count, never null — zero unpriced expenses is a real answer.
              cell: (info) => info.getValue(),
            }),
            enableSorting: sortFieldForColumn(column) !== undefined,
          });
          return;
        case "netSpend":
          add({
            ...createCurrencyColumn(helper, "netSpend", {
              header: COLUMN_LABELS.netSpend,
              className: "w-24",
            }),
            enableSorting: sortFieldForColumn(column) !== undefined,
          });
          return;
        case "items":
          add({
            ...createCurrencyColumn(helper, "itemSpend", {
              header: COLUMN_LABELS.items,
              className: "w-24",
            }),
            id: "items",
            enableSorting: false,
          });
          return;
        case "sharedCharges":
          add({
            ...createCurrencyColumn(helper, "sharedChargeSpend", {
              header: COLUMN_LABELS.sharedCharges,
              className: "w-28",
            }),
            id: "sharedCharges",
            enableSorting: false,
          });
          return;
        case "coverage":
          add({
            ...helper.accessor((row) => row.incomplete, {
              id: "coverage",
              header: COLUMN_LABELS.coverage,
              meta: { className: "w-24" },
              cell: (info) =>
                info.getValue() ? (
                  <span className="text-warning">Incomplete</span>
                ) : (
                  <span className="text-muted-foreground">Complete</span>
                ),
            }),
            enableSorting: false,
          });
          return;
        case "latestActivity":
          add({
            ...helper.accessor((row) => row.latestActivity, {
              id: "latestActivity",
              header: COLUMN_LABELS.latestActivity,
              meta: { className: "w-24", numeric: true, mono: true },
              cell: (info) => info.getValue() ?? "—",
            }),
            enableSorting: sortFieldForColumn(column) !== undefined,
          });
      }
    };

    return createCubbyColumnCollection<SummaryTableRow>((add) => {
      add(
        helper.display({
          id: "image",
          header: () => <ImageIcon className="size-3 text-muted-foreground" />,
          meta: { className: "h-px w-16 overflow-hidden px-0 py-0" },
          cell: (info) => targetImage(info.row.original.target, targetEntity),
        }),
      );
      for (const column of columns) {
        // Only the columns the server can order by are sortable; the rest would
        // silently do nothing under `manualSorting`.
        build(column, add);
      }
      add(
        helper.display({
          id: "ledger",
          header: "",
          meta: { className: "w-16" },
          cell: (info) => {
            const target = info.row.original.target;
            return (
              <a
                href={expenseHrefRef.current(target)}
                className="text-primary hover:underline"
                aria-label={`View ${target?.label ?? nullLabel} expenses`}
              >
                Ledger
              </a>
            );
          },
        }),
      );
    });
    // oxlint-disable-next-line react/exhaustive-deps -- columnsKey is the deep-compare stand-in for `columns`; expenseHref is read through a ref
  }, [helper, columnsKey, targetEntity, nullLabel]);

  const sorting = useMemo<SortingState>(
    () => [{ id: columnForSort(sort.field), desc: sort.direction === "desc" }],
    [sort],
  );

  const onSortingChange = useCallback<OnChangeFn<SortingState>>(
    (updater) => {
      const next = isSortingUpdater(updater) ? updater(sorting) : updater;
      const first = next[0];
      if (!first) return;
      const field = sortFieldForColumn(first.id);
      if (!field) return;
      setSort({ field, direction: first.desc ? "desc" : "asc" });
    },
    [sorting],
  );

  const { columns: normalizedColumns, defaultLayout } = useTableColumnLayout({
    columns: tableColumns,
  });
  const table = useCubbyTable({
    data: rows,
    columns: normalizedColumns,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
    meta: { defaultLayout },
    getRowId: (row) => row.id,
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    // A cleared sort would leave the server input undefined; toggling between
    // asc and desc is the whole interaction here.
    enableSortingRemoval: false,
    state: { sorting },
    onSortingChange,
  });

  const infiniteScroll = useMemo<InfiniteScrollControls<SummaryTableRow>>(
    () => ({
      fetchNextPage: () => {
        void query.fetchNextPage();
      },
      // Placeholder rows belong to the previous scope — never page into the new
      // query off their metadata.
      hasNextPage: !query.isPlaceholderData && query.hasNextPage,
      isFetchingNextPage: query.isFetchingNextPage,
      isTransitioning: query.isPlaceholderData,
      // No select-all on an aggregate table; the loaded set is the whole answer.
      loadAllPages: async () => rows,
    }),
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
    [
      query.fetchNextPage,
      query.hasNextPage,
      query.isFetchingNextPage,
      query.isPlaceholderData,
      rows,
    ],
  );

  const toolbar = (
    <>
      {/* min-w floor, because these sections also sit in the narrow aside rail
          where a flex-1 input otherwise collapses to a few characters. */}
      <div className="relative min-w-32 flex-1">
        <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search…"
          aria-label="Search relationship summary"
          className="h-7 pl-6"
        />
      </div>
      {summary && (
        <span className="min-w-0 truncate text-right font-mono text-2xs text-muted-foreground tabular-nums">
          {summary.count} {summary.count === 1 ? "group" : "groups"}
          {" · "}
          {columns.includes("items") ? (
            <>
              {formatCurrency(summary.totals.itemSpend)} items +{" "}
              {formatCurrency(summary.totals.sharedChargeSpend)} shared ={" "}
              {formatCurrency(summary.totals.netSpend)} total
              {summary.totals.incomplete ? " · incomplete coverage" : ""}
            </>
          ) : (
            <>{formatCurrency(summary.totals.netSpend)} net</>
          )}
          {summary.totals.unpricedExpenseCount > 0 &&
            ` · ${summary.totals.unpricedExpenseCount} unpriced`}
        </span>
      )}
    </>
  );

  return (
    <Stack gap="sm">
      {note && <Description>{note}</Description>}
      <RTable
        table={table}
        entity={targetEntity}
        ariaLabel={`${relationKey} summary`}
        embedded
        isLoading={query.isPending}
        error={query.error}
        infiniteScroll={infiniteScroll}
        additionalToolbarContent={toolbar}
        // The search is ours, not a column filter, so RTable can't tell an
        // empty relationship from a search that matched nothing.
        emptyState={search ? "No groups match this search." : emptyCopy}
      />
    </Stack>
  );
};
