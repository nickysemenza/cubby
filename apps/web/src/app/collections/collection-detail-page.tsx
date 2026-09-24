import type {
  CollectionProductOut,
  CollectionSlug,
  SmartCollectionMatch,
} from "@cubby/schemas/collection";
import { formatCollectionLabel } from "@cubby/shared/collection-tag";
import { CubeFocusIcon } from "@phosphor-icons/react/dist/csr/CubeFocus";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  functionalUpdate,
  type OnChangeFn,
  type PaginationState,
} from "@tanstack/react-table";
import { useCallback, useEffect, useId, useMemo } from "react";

import { useTableColumnLayout } from "~/app/_components/data-table/column-layout";
import {
  createImageColumn,
  createNameColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { EntityCover } from "~/components/entity/entity-cover";
import { Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { Skeleton } from "~/components/ui/skeleton";

import {
  CopyableShortcode,
  ProductPlacementsPopover,
  ProductPurchasesPopover,
  ProductTradeBadges,
} from "./collection-product-context";
import { collection as collectionOperations } from "./collection.functions";

const PAGE_SIZE = 50;
const PRODUCT_TABLE_LAYOUT_KEY = "collection:detail-products";
const productColumnHelper = createCubbyColumnHelper<CollectionProductOut>();

export type CollectionDetailOperations = Pick<
  typeof collectionOperations,
  "detail"
>;

function CollectionMembership({
  direct,
  inherited,
  matches,
}: Pick<CollectionProductOut, "direct" | "inherited" | "matches">) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {direct && <Badge variant="outline">Direct</Badge>}
        {inherited && <Badge variant="secondary">From location</Badge>}
        {matches?.length ? <Badge variant="secondary">Dynamic</Badge> : null}
      </div>
      {matches?.length ? <SmartMatchEvidence matches={matches} /> : null}
    </div>
  );
}

function SmartMatchEvidence({ matches }: { matches: SmartCollectionMatch[] }) {
  return (
    <div>
      <p className="line-clamp-1 text-2xs leading-tight text-muted-foreground">
        {formatSmartMatch(matches[0]!)}
      </p>
      <Popover>
        <PopoverTrigger
          openOnHover
          closeDelay={150}
          className="inline-flex min-h-11 items-center text-2xs text-muted-foreground underline decoration-border decoration-dotted underline-offset-2 hover:text-primary hover:decoration-primary focus-visible:outline-2 focus-visible:outline-ring md:h-5 md:min-h-0"
          aria-label={`Why included: ${matches.length} ${matches.length === 1 ? "match" : "matches"}`}
        >
          Why included
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" className="w-80 p-0">
          <PopoverHeader className="border-b border-border p-2">
            <PopoverTitle>Why this Product is included</PopoverTitle>
          </PopoverHeader>
          <ul className="max-h-72 divide-y divide-border overflow-y-auto">
            {matches.map((match) => (
              <li key={`${match.ruleIndex}:${match.kind}`} className="p-2">
                <p className="font-medium">{formatSmartMatch(match)}</p>
                <p className="mt-0.5 text-2xs text-muted-foreground">
                  Rule {match.ruleIndex + 1}
                </p>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function formatSmartMatch(match: SmartCollectionMatch): string {
  const evidence = match.evidence.join(" · ");
  if (evidence) return evidence;
  switch (match.kind) {
    case "effectiveOwnerEquals":
      return `Owner is ${match.value}`;
    case "categoryEquals":
      return `Classification is ${match.value}`;
    case "categoryFeatureEquals":
      return `Classification feature is ${match.value}`;
    case "manufacturerEquals":
      return `Manufacturer is ${match.value}`;
    case "productTagEquals":
      return `Tagged ${match.value}`;
    case "locationNameContains":
      return `Location contains “${match.value}”`;
    case "historicalExpenseTrade":
      return `Historical Trade: ${match.value}`;
  }
}

export function CollectionProductsTable({
  products,
  totalCount,
  search,
  page,
  onSearchChange,
}: {
  products: CollectionProductOut[];
  totalCount: number;
  search?: string;
  page: number;
  onSearchChange: (next: { q?: string; page?: number }) => void;
}) {
  const lastPage = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  useEffect(() => {
    if (page > lastPage) onSearchChange({ page: lastPage });
  }, [lastPage, page, onSearchChange]);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<CollectionProductOut>((add) => {
        add(
          createImageColumn(productColumnHelper, {
            entity: "product",
            getImages: (product) =>
              product.imageUrl
                ? [{ id: product.id, url: product.imageUrl }]
                : [],
          }),
        );
        add(
          createNameColumn(productColumnHelper, "product", "name", {
            header: "Product",
            nameSuffix: (product) => <CopyableShortcode code={product.id} />,
          }),
        );
        add(
          productColumnHelper.accessor("manufacturer", {
            header: "Manufacturer",
            enableSorting: false,
            meta: {
              className: "w-40",
              mobile: { slot: "subtitle", priority: 10 },
            },
            cell: (info) => (
              <span className="truncate text-muted-foreground">
                {info.getValue()}
              </span>
            ),
          }),
        );
        add(
          productColumnHelper.display({
            id: "membership",
            header: "Membership",
            enableSorting: false,
            enableCellSelection: false,
            meta: {
              className: "w-48",
              mobile: {
                slot: "meta",
                priority: 20,
                label: "Membership",
                interactive: true,
              },
            },
            cell: ({ row }) => <CollectionMembership {...row.original} />,
          }),
        );
        add(
          productColumnHelper.display({
            id: "inventoryQuantity",
            header: "Quantity",
            enableSorting: false,
            enableCellSelection: false,
            meta: {
              className: "w-28",
              mobile: {
                slot: "meta",
                priority: 25,
                label: "Quantity",
              },
            },
            cell: ({ row }) => {
              const totals = new Map<string, number>();
              for (const entry of row.original.inventory ?? []) {
                totals.set(
                  entry.amount.unit,
                  (totals.get(entry.amount.unit) ?? 0) + entry.amount.value,
                );
              }
              return (
                [...totals]
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([unit, value]) => tryFormatAmount({ value, unit }))
                  .join(" + ") || "—"
              );
            },
          }),
        );
        add(
          productColumnHelper.display({
            id: "placements",
            header: "Current locations",
            enableSorting: false,
            enableCellSelection: false,
            meta: {
              className: "w-36",
              mobile: {
                slot: "meta",
                priority: 30,
                label: "Locations",
                interactive: true,
              },
            },
            cell: ({ row }) => (
              <ProductPlacementsPopover placements={row.original.placements} />
            ),
          }),
        );
        add(
          productColumnHelper.display({
            id: "purchases",
            header: "Purchase history",
            enableSorting: false,
            enableCellSelection: false,
            meta: {
              className: "w-44",
              mobile: {
                slot: "meta",
                priority: 40,
                label: "Purchases",
                interactive: true,
              },
            },
            cell: ({ row }) => (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <ProductPurchasesPopover purchases={row.original.purchases} />
                <ProductTradeBadges purchases={row.original.purchases} />
              </div>
            ),
          }),
        );
      }),
    [],
  );
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const pagination = useMemo<PaginationState>(
    () => ({ pageIndex: page - 1, pageSize: PAGE_SIZE }),
    [page],
  );
  const onPaginationChange = useCallback<OnChangeFn<PaginationState>>(
    (updater) => {
      const next = functionalUpdate(updater, pagination);
      if (next.pageIndex === pagination.pageIndex) return;
      onSearchChange({ page: next.pageIndex + 1 });
    },
    [onSearchChange, pagination],
  );
  const table = useCubbyTable({
    data: products,
    columns: tableColumns,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
    getRowId: (product) => product.id,
    enableSorting: false,
    enableRowSelection: false,
    enableCellSelection: false,
    manualFiltering: true,
    manualPagination: true,
    rowCount: totalCount,
    state: { pagination },
    onPaginationChange,
    meta: {
      defaultLayout,
      scrollRestorationId: PRODUCT_TABLE_LAYOUT_KEY,
    },
  });
  const rangeStart =
    totalCount === 0 ? 0 : Math.min((page - 1) * PAGE_SIZE + 1, totalCount);
  const rangeEnd = Math.min(page * PAGE_SIZE, totalCount);
  const toolbar = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <div className="relative min-w-52 flex-1 sm:max-w-72">
        <MagnifyingGlassIcon
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          className="h-7 pl-7"
          value={search ?? ""}
          onChange={(event) =>
            onSearchChange({ q: event.target.value || undefined, page: 1 })
          }
          placeholder="Search name or manufacturer"
          aria-label="Search products"
        />
      </div>
      <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
        {rangeStart}–{rangeEnd} of {totalCount}
      </span>
    </div>
  );

  return (
    <RTable
      table={table}
      ariaLabel="Collection products"
      embedded
      showColumnMenu
      additionalToolbarContent={toolbar}
      getMobileDetailsHref={(product) => `/products/${product.id}`}
      emptyState={
        <div className="py-6 text-center">
          <CubeFocusIcon
            className="mx-auto size-5 text-muted-foreground"
            aria-hidden
          />
          <p className="mt-2 font-medium">No matching products</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Try a product name or manufacturer.
          </p>
        </div>
      }
    />
  );
}

function CollectionDetailLoading() {
  return (
    <Stack gap="lg" aria-label="Loading Collection">
      <Skeleton className="h-10 w-full" />
      <div className="grid gap-px border border-border bg-border sm:grid-cols-2">
        {[0, 1].map((key) => (
          <Skeleton key={key} className="h-20" />
        ))}
      </div>
      <div className="border-y border-border">
        {[0, 1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-24 border-b border-border" />
        ))}
      </div>
    </Stack>
  );
}

export function CollectionDetailPage({
  collection,
  search,
  page,
  onSearchChange,
  operations = collectionOperations,
}: {
  collection: CollectionSlug;
  search?: string;
  page: number;
  onSearchChange: (next: { q?: string; page?: number }) => void;
  /** Remote Collection operations; production uses the shared catalog. */
  operations?: CollectionDetailOperations;
}) {
  const rootsHeadingId = useId();
  const productsHeadingId = useId();
  const result = useQuery(
    operations.detail.queryOptions({
      collection,
      search,
      pagination: { pageIndex: page - 1, pageSize: PAGE_SIZE },
    }),
  );
  const data = result.data;
  const totalCount = data?.totalCount ?? 0;

  if (result.isLoading) return <CollectionDetailLoading />;
  if (result.error)
    return (
      <div className="border-y border-destructive/40 py-8 text-center">
        <p className="font-medium text-destructive">
          Could not load this Collection
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {result.error.message}
        </p>
      </div>
    );
  if (!data) return null;

  return (
    <Stack gap="lg">
      <div className="flex flex-wrap items-center justify-between gap-2 border-y border-border py-2">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">
            {data.collection.productCount}
          </span>{" "}
          products gathered from{" "}
          <span className="font-medium text-foreground tabular-nums">
            {data.roots.length}
          </span>{" "}
          tagged {data.roots.length === 1 ? "location" : "locations"}
        </p>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/collections/assignments" />}
        >
          Manage assignments
        </Button>
      </div>

      <section aria-labelledby={rootsHeadingId}>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 id={rootsHeadingId} className="text-sm font-semibold">
            Location roots
          </h2>
          <span className="font-mono text-2xs text-muted-foreground tabular-nums">
            {data.roots.length} tagged
          </span>
        </div>
        {data.roots.length ? (
          <div className="grid gap-px border border-border bg-border sm:grid-cols-2">
            {data.roots.map((root) => {
              const parentPath = root.path.slice(0, -1).join(" / ");
              return (
                <article
                  key={root.id}
                  className="flex min-w-0 items-center gap-2 bg-card p-2 transition-colors hover:bg-muted/30"
                >
                  <EntityCover
                    images={
                      root.imageUrl ? [{ id: root.id, url: root.imageUrl }] : []
                    }
                    entity="location"
                    alt={`${root.name} cover`}
                    size={64}
                    preview
                    lazyPreview
                    className="border border-border"
                  />
                  <div className="min-w-0">
                    <Link
                      to="/locations/$shortcode"
                      params={{ shortcode: root.id }}
                      title={root.path.join(" / ")}
                      className="line-clamp-2 leading-tight font-medium hover:text-primary hover:underline"
                    >
                      {root.name}
                    </Link>
                    <p
                      className="mt-1 truncate text-xs text-muted-foreground"
                      title={parentPath || "Top-level location"}
                    >
                      {parentPath || "Top-level location"}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <CopyableShortcode code={root.id} />
                      <span className="flex items-center gap-1 font-mono text-2xs tracking-wider text-muted-foreground uppercase">
                        <MapPinIcon className="size-3" aria-hidden /> Tagged
                        root
                      </span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="border-y border-border py-6 text-center">
            <p className="text-sm font-medium">No tagged Location roots</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Membership currently comes from direct Product tags.
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby={productsHeadingId}>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 id={productsHeadingId} className="text-sm font-semibold">
            {formatCollectionLabel(collection)} products
          </h2>
          <span className="font-mono text-2xs text-muted-foreground tabular-nums">
            {totalCount} total
          </span>
        </div>

        <CollectionProductsTable
          products={data.products}
          totalCount={totalCount}
          search={search}
          page={page}
          onSearchChange={onSearchChange}
        />
      </section>
    </Stack>
  );
}
