import type {
  RelatedSummaryInput,
  RelatedSummaryOutput,
  RelatedSummaryRelationKey,
} from "@cubby/schemas/related-view";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import type { OnChangeFn, SortingState } from "@tanstack/react-table";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ImageIcon, Search } from "lucide-react";
import { type FC, useCallback, useMemo, useRef, useState } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { ImageThumbnail } from "~/app/_components/table/ImageThumbnail";
import { VendorMark } from "~/components/entity/vendor-cell";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { useTRPC, useTRPCClient } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";
import { createCurrencyColumn } from "../data-table/columnHelpers";
import RTable from "../data-table/Table";
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
}

const COLUMN_LABELS: Record<Column, string> = {
  target: "Name",
  acquired: "Acquired",
  purchases: "Purchases",
  expenses: "Expenses",
  unpriced: "Unpriced",
  netSpend: "Net spend",
  latestActivity: "Latest",
};

const SORT_BY_COLUMN: Partial<Record<Column, SortField>> = {
  target: "target",
  acquired: "knownAcquiredUnits",
  purchases: "purchaseCount",
  expenses: "expenseCount",
  netSpend: "netSpend",
  latestActivity: "latestActivity",
};

const COLUMN_BY_SORT = Object.fromEntries(
  Object.entries(SORT_BY_COLUMN).map(([column, field]) => [field, column]),
) as Record<SortField, Column>;

const TARGET_ENTITY_BY_RELATION: Record<
  RelatedSummaryRelationKey,
  NonNullable<SummaryRow["target"]>["entity"]
> = {
  "vendor.products": "product",
  "vendor.projects": "project",
  "purchase.projects": "project",
  "project.vendors": "vendor",
  "project.purchasedProducts": "product",
  "product.vendors": "vendor",
};

function targetImage(
  target: SummaryRow["target"],
  fallbackEntity: NonNullable<SummaryRow["target"]>["entity"],
) {
  if (target?.entity === "vendor") {
    return (
      <div className="flex h-full items-center justify-center">
        <VendorMark vendor={target.label} vendorId={target.id} />
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
}) => {
  const api = useTRPC();
  const client = useTRPCClient();
  const targetEntity = TARGET_ENTITY_BY_RELATION[relationKey];
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

  // Search/sort changes swap the key, so a new scope always starts at offset 0
  // and the previous rows stay visible (keepPreviousData) while it loads.
  const queryKey = useMemo(
    () => [
      ...api.relatedData.summary.queryOptions(pageInput(0)).queryKey,
      "__infinite__",
    ],
    [api, pageInput],
  );

  const query = useInfiniteQuery({
    queryKey,
    placeholderData: keepPreviousData,
    initialPageParam: 0,
    queryFn: ({ pageParam }: { pageParam: number }) =>
      client.relatedData.summary.query(pageInput(pageParam)),
    getNextPageParam: (lastPage: RelatedSummaryOutput) =>
      lastPage.nextOffset ?? undefined,
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

  const helper = useMemo(() => createColumnHelper<SummaryTableRow>(), []);

  // Every call site passes a fresh arrow / array literal. Column defs must not
  // churn on that: TanStack caches accessor results per row and only rebuilds
  // the row model when `data` changes, so a rebuilt column carrying a fresh
  // closure would still read stale cached values (see `createImageColumn`).
  const expenseHrefRef = useRef(expenseHref);
  expenseHrefRef.current = expenseHref;
  const columnsKey = columns.join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: columnsKey is the deep-compare stand-in for `columns`; expenseHref is read through a ref
  const tableColumns = useMemo(() => {
    const build = (column: Column) => {
      switch (column) {
        case "target":
          return helper.accessor((row) => row.target, {
            id: "target",
            header: COLUMN_LABELS.target,
            meta: { className: "min-w-0 w-48" },
            cell: (info) => {
              const target = info.getValue();
              if (!target) {
                return (
                  <span className="font-medium text-warning">{nullLabel}</span>
                );
              }
              return (
                <EntityInlineLink
                  entity={target.entity}
                  data={{ id: target.id, name: target.label }}
                  truncate
                />
              );
            },
          });
        case "acquired":
          return helper.accessor((row) => row.knownAcquiredUnits, {
            id: "acquired",
            header: COLUMN_LABELS.acquired,
            meta: { className: "w-20", numeric: true, mono: true },
            cell: (info) => (
              <span>
                {info.getValue()}
                {info.row.original.unknownAcquisitionQuantityCount > 0 && (
                  <span className="text-warning">
                    {` +${info.row.original.unknownAcquisitionQuantityCount}?`}
                  </span>
                )}
              </span>
            ),
          });
        case "purchases":
          return helper.accessor((row) => row.purchaseCount, {
            id: "purchases",
            header: COLUMN_LABELS.purchases,
            meta: { className: "w-20", numeric: true, mono: true },
          });
        case "expenses":
          return helper.accessor((row) => row.expenseCount, {
            id: "expenses",
            header: COLUMN_LABELS.expenses,
            meta: { className: "w-20", numeric: true, mono: true },
          });
        case "unpriced":
          return helper.accessor((row) => row.unpricedExpenseCount, {
            id: "unpriced",
            header: COLUMN_LABELS.unpriced,
            meta: { className: "w-20", numeric: true, mono: true },
            cell: (info) => (info.getValue() === 0 ? "—" : info.getValue()),
          });
        case "netSpend":
          return createCurrencyColumn(helper, "netSpend", {
            header: COLUMN_LABELS.netSpend,
            className: "w-24",
            // An aggregate that nets to zero is a real answer (offsetting
            // refunds), not an unset price.
            zeroAsEmpty: false,
          });
        case "latestActivity":
          return helper.accessor((row) => row.latestActivity, {
            id: "latestActivity",
            header: COLUMN_LABELS.latestActivity,
            meta: { className: "w-24", numeric: true, mono: true },
            cell: (info) => info.getValue() ?? "—",
          });
      }
    };

    return [
      helper.display({
        id: "image",
        header: () => <ImageIcon className="size-3 text-muted-foreground" />,
        meta: { className: "h-px w-16 overflow-hidden px-0 py-0" },
        cell: (info) => targetImage(info.row.original.target, targetEntity),
      }),
      ...columns.map((column) => {
        const built = build(column);
        // Only the columns the server can order by are sortable; the rest would
        // silently do nothing under `manualSorting`.
        return {
          ...built,
          enableSorting: SORT_BY_COLUMN[column] !== undefined,
        };
      }),
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
    ];
  }, [helper, columnsKey, targetEntity, nullLabel]);

  const sorting = useMemo<SortingState>(
    () => [{ id: COLUMN_BY_SORT[sort.field], desc: sort.direction === "desc" }],
    [sort],
  );

  const onSortingChange = useCallback<OnChangeFn<SortingState>>(
    (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const first = next[0];
      if (!first) return;
      const field = SORT_BY_COLUMN[first.id as Column];
      if (!field) return;
      setSort({ field, direction: first.desc ? "desc" : "asc" });
    },
    [sorting],
  );

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
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
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
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
          {formatCurrency(summary.totals.netSpend)} net
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
        sizingKey={`related-summary:${relationKey}`}
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
