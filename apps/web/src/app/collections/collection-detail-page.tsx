import type { CollectionSlug } from "@cubby/schemas/collection";
import { formatCollectionLabel } from "@cubby/shared/collection-tag";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChevronLeft,
  ChevronRight,
  MapPin,
  PackageSearch,
  Search,
} from "lucide-react";
import { useId } from "react";
import { EntityCover } from "~/components/entity/entity-cover";
import { Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { collection as collectionOperations } from "./collection.functions";
import {
  CopyableShortcode,
  ProductPlacementsPopover,
  ProductPurchasesPopover,
  ProductTradeBadges,
} from "./collection-product-context";

const PAGE_SIZE = 50;

function CollectionDetailLoading() {
  return (
    <Stack gap="lg" aria-label="Loading Collection">
      <Skeleton className="h-10 w-full" />
      <div className="grid gap-px border border-border bg-border sm:grid-cols-2">
        {[0, 1].map((key) => (
          <Skeleton key={key} className="h-20" />
        ))}
      </div>
      <div className="border-border border-y">
        {[0, 1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-24 border-border border-b" />
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
}: {
  collection: CollectionSlug;
  search?: string;
  page: number;
  onSearchChange: (next: { q?: string; page?: number }) => void;
}) {
  const rootsHeadingId = useId();
  const productsHeadingId = useId();
  const result = useQuery(
    collectionOperations.detail.queryOptions({
      collection,
      search,
      pagination: { pageIndex: page - 1, pageSize: PAGE_SIZE },
    }),
  );
  const data = result.data;
  const totalCount = data?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, totalCount);

  if (result.isLoading) return <CollectionDetailLoading />;
  if (result.error)
    return (
      <div className="border-destructive/40 border-y py-8 text-center">
        <p className="font-medium text-destructive">
          Could not load this Collection
        </p>
        <p className="mt-1 text-muted-foreground text-xs">
          {result.error.message}
        </p>
      </div>
    );
  if (!data) return null;

  return (
    <Stack gap="lg">
      <div className="flex flex-wrap items-center justify-between gap-2 border-border border-y py-2">
        <p className="text-muted-foreground text-xs">
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
          render={<Link to="/collections/assignments" />}
        >
          Manage assignments
        </Button>
      </div>

      <section aria-labelledby={rootsHeadingId}>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 id={rootsHeadingId} className="font-semibold text-sm">
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
                      className="line-clamp-2 font-medium leading-tight hover:text-primary hover:underline"
                    >
                      {root.name}
                    </Link>
                    <p
                      className="mt-1 truncate text-muted-foreground text-xs"
                      title={parentPath || "Top-level location"}
                    >
                      {parentPath || "Top-level location"}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <CopyableShortcode code={root.id} />
                      <span className="flex items-center gap-1 font-mono text-2xs text-muted-foreground uppercase tracking-wider">
                        <MapPin className="size-3" aria-hidden /> Tagged root
                      </span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="border-border border-y py-6 text-center">
            <p className="font-medium text-sm">No tagged Location roots</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Membership currently comes from direct Product tags.
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby={productsHeadingId}>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id={productsHeadingId} className="font-semibold text-sm">
              {formatCollectionLabel(collection)} products
            </h2>
            <p className="mt-1 font-mono text-2xs text-muted-foreground tabular-nums">
              Showing {rangeStart}–{rangeEnd} of {totalCount}
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              className="pl-8"
              value={search ?? ""}
              onChange={(event) =>
                onSearchChange({ q: event.target.value || undefined, page: 1 })
              }
              placeholder="Search name or manufacturer"
              aria-label="Search products"
            />
          </div>
        </div>

        {data.products.length ? (
          <div className="border-border border-y">
            <div className="hidden grid-cols-[3.5rem_minmax(12rem,0.85fr)_minmax(14rem,1.15fr)_minmax(10rem,0.8fr)] items-center gap-x-2 border-border border-b bg-card px-2 py-1 font-mono text-2xs text-muted-foreground uppercase tracking-wider lg:grid">
              <span aria-hidden />
              <span>Product</span>
              <span>Current locations</span>
              <span>Purchase history</span>
            </div>
            <div>
              {data.products.map((product) => (
                <article
                  key={product.id}
                  className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-2 border-border border-b p-2 transition-colors last:border-b-0 odd:bg-card hover:bg-muted/30 lg:grid-cols-[3.5rem_minmax(12rem,0.85fr)_minmax(14rem,1.15fr)_minmax(10rem,0.8fr)] lg:items-center"
                >
                  <EntityCover
                    images={
                      product.imageUrl
                        ? [{ id: product.id, url: product.imageUrl }]
                        : []
                    }
                    entity="product"
                    alt={`${product.name} cover`}
                    size={56}
                    preview
                    lazyPreview
                    className="border border-border bg-card"
                  />

                  <div className="min-w-0 self-center">
                    <Link
                      to="/products/$shortcode"
                      params={{ shortcode: product.id }}
                      title={product.name}
                      className="line-clamp-2 font-medium leading-tight hover:text-primary hover:underline"
                    >
                      {product.name}
                    </Link>
                    {product.manufacturer && (
                      <p className="mt-1 truncate text-muted-foreground text-xs">
                        {product.manufacturer}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <CopyableShortcode code={product.id} />
                      {product.direct && (
                        <Badge variant="outline">Direct</Badge>
                      )}
                      {product.inherited && (
                        <Badge variant="secondary">From location</Badge>
                      )}
                    </div>
                  </div>

                  <div className="col-start-2 min-w-0 lg:col-start-auto">
                    <p className="mb-1 font-mono text-2xs text-muted-foreground uppercase tracking-wider lg:sr-only">
                      Current locations
                    </p>
                    {product.placements.length ? (
                      <div className="flex flex-col items-start gap-1">
                        {product.placements.slice(0, 2).map((placement) => (
                          <Link
                            key={placement.id}
                            to="/locations/$shortcode"
                            params={{ shortcode: placement.id }}
                            title={placement.path.join(" / ")}
                            className="inline-flex min-w-0 items-center gap-1 text-xs hover:text-primary hover:underline"
                          >
                            <MapPin
                              className="size-3 shrink-0 text-muted-foreground"
                              aria-hidden
                            />
                            <span className="line-clamp-1">
                              {placement.path.join(" / ")}
                            </span>
                          </Link>
                        ))}
                        {product.placements.length > 2 && (
                          <ProductPlacementsPopover
                            placements={product.placements}
                          />
                        )}
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        Not currently placed
                      </p>
                    )}
                  </div>

                  <div className="col-start-2 min-w-0 lg:col-start-auto">
                    <p className="mb-1 font-mono text-2xs text-muted-foreground uppercase tracking-wider lg:sr-only">
                      Purchase history
                    </p>
                    <ProductPurchasesPopover purchases={product.purchases} />
                    <ProductTradeBadges
                      purchases={product.purchases}
                      className="mt-2"
                    />
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <div className="border-border border-y py-6 text-center">
            <PackageSearch
              className="mx-auto size-5 text-muted-foreground"
              aria-hidden
            />
            <p className="mt-2 font-medium">No matching products</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Try a product name or manufacturer.
            </p>
          </div>
        )}

        {pageCount > 1 && (
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => onSearchChange({ page: page - 1 })}
            >
              <ChevronLeft />
            </Button>
            <span className="font-mono text-2xs tabular-nums">
              {page} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next page"
              disabled={page >= pageCount}
              onClick={() => onSearchChange({ page: page + 1 })}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </section>
    </Stack>
  );
}
