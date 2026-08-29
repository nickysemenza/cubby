import type {
  CollectionProductOut,
  CollectionSlug,
} from "@cubby/schemas/collection";
import { formatCollectionLabel } from "@cubby/shared/collection-tag";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  functionalUpdate,
  type OnChangeFn,
  type PaginationState,
} from "@tanstack/react-table";
import { MapPin, PackageSearch, Search } from "lucide-react";
import { useCallback, useId, useMemo } from "react";

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
import { useCubbyTableLayout } from "~/app/_components/data-table/table-layout";
import { EntityCover } from "~/components/entity/entity-cover";
import { Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
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
}: Pick<CollectionProductOut, "direct" | "inherited">) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {direct && <Badge variant="outline">Direct</Badge>}
      {inherited && <Badge variant="secondary">From location</Badge>}
    </div>
  );
}

function CollectionProductsTable({
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
              className: "w-32",
              mobile: { slot: "meta", priority: 20, label: "Membership" },
            },
            cell: ({ row }) => <CollectionMembership {...row.original} />,
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
  const layout = useCubbyTableLayout({
    key: PRODUCT_TABLE_LAYOUT_KEY,
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
    columns: layout.columns,
    atoms: layout.atoms,
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
      defaultLayout: layout.defaultLayout,
      scrollRestorationId: PRODUCT_TABLE_LAYOUT_KEY,
    },
  });
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, totalCount);
  const toolbar = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <div className="relative min-w-52 flex-1 sm:max-w-72">
        <Search
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
          <PackageSearch
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
                        <MapPin className="size-3" aria-hidden /> Tagged root
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
