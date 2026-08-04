import type { WishFilters, WishOut } from "@cubby/schemas/wish";
import { createColumnHelper } from "@tanstack/react-table";
import { uniq } from "es-toolkit";
import { ImageIcon, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import RTable from "~/app/_components/data-table/Table";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
  useHydratedProductImagesForAll,
} from "~/app/_components/products/product-image-summaries";
import { ImageThumbnail } from "~/app/_components/table/ImageThumbnail";
import { usePageCount } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrencyRange } from "~/lib/format-range";
import { wishMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { WishFormDialog } from "./wish-form-dialog";
import { wishPriceRange } from "./wish-price-range";
import { buildWishRows, type WishRow, wishSubRows } from "./wish-rows";

/**
 * Tree config for the wishlist. Module-level so the reference is stable —
 * `useEntityList` feeds `nest` straight into a `useMemo`.
 *
 * The children are Products, not Wishes, so this is the first heterogeneous
 * tree in the repo: `rowLink` sends each row to its own entity's detail page,
 * and `rowIsEntity` keeps the wish-only affordances (selection, the row menu's
 * Delete) off candidate rows.
 */
const WISH_TREE_CONFIG = {
  nest: buildWishRows,
  getSubRows: wishSubRows,
  expandable: true,
  rowIsEntity: (row: WishRow) => row.kind === "wish",
  rowLink: (row: WishRow) =>
    row.kind === "wish"
      ? {
          to: entities.wish.routes.detail,
          params: entityDetailParams(row.id),
        }
      : {
          to: entities.product.routes.detail,
          // The row id is namespaced by its parent wish; the product's own
          // shortcode is what the route wants.
          params: entityDetailParams(row.productId),
        },
} as const;

export function WishList() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<WishRow>(), []);
  const [open, setOpen] = useState(false);

  const deletableConfig = useDeletableConfig({
    mutationFn: api.wish.delete.mutationOptions,
    entityLabel: "Wish",
    invalidateKeys: wishMutationInvalidateKeys,
    entity: "wish",
  });

  const columns = useMemo(
    () => [
      // Covers belong to the candidate Products, not to the wish, so they're
      // fetched independently of `wish.list` (same pattern as the expense
      // ledger's product column). A collapsed wish shows every candidate's
      // images merged, so the `+N` badge reads as "more options"; an expanded
      // child shows only its own.
      columnHelper.display({
        id: "image",
        header: () => <ImageIcon className="size-3 text-muted-foreground" />,
        enableSorting: false,
        meta: {
          className: "h-px w-16 overflow-hidden px-0 py-0",
          mobile: { slot: "image", priority: -10 },
        },
        cell: (info) => <WishRowCover row={info.row.original} />,
      }),
      // `id: "acquired"` matches the `wish` filter manifest's boolean spec, so
      // the header filter control is picked up automatically — see
      // `useStandardColumns`' `withManifestFilter`. A candidate row shows
      // whether it's already on a shelf instead: the nearest thing that column
      // means for a Product.
      columnHelper.accessor(
        (row) => (row.kind === "wish" ? row.wish.acquiredAt : null),
        {
          id: "acquired",
          header: "Status",
          meta: {
            className: "w-28",
            mobile: { slot: "trailing", priority: 10 },
          },
          cell: (info) => {
            const row = info.row.original;
            if (row.kind === "candidate") {
              return row.candidate.inventoried ? (
                <Badge variant="positive">In inventory</Badge>
              ) : (
                <NoneValue />
              );
            }
            return row.wish.acquiredAt ? (
              <Badge variant="positive">Acquired</Badge>
            ) : (
              <Badge variant="slate">Wanted</Badge>
            );
          },
        },
      ),
      // The candidate's manufacturer/model, which is what tells two otherwise
      // similarly-named alternatives apart. Blank on wish rows — a wish has no
      // maker of its own.
      columnHelper.display({
        id: "candidateSpec",
        header: "Make / model",
        meta: {
          className: "w-56",
          mobile: { slot: "subtitle", priority: 15 },
        },
        cell: (info) => {
          const row = info.row.original;
          if (row.kind !== "candidate") return null;
          const { manufacturer, model } = row.candidate;
          return (
            <span className="block truncate text-muted-foreground">
              {manufacturer}
              {model ? ` · ${model}` : ""}
            </span>
          );
        },
      }),
      columnHelper.accessor(
        (row) => (row.kind === "wish" ? row.wish.candidates.length : null),
        {
          id: "candidateCount",
          header: "Options",
          meta: {
            numeric: true,
            className: "w-24",
            mobile: { slot: "meta", priority: 20 },
          },
          cell: (info) => {
            const count = info.getValue();
            if (count === null) return null;
            return <span className="font-mono tabular-nums">{count}</span>;
          },
        },
      ),
      // Hand-rolled rather than `createCurrencyColumn`: that helper renders one
      // scalar, and a wish row's value is a span. Sorting is wired by
      // `useStandardColumns` because "priceRange" is in `wishSortableFields`
      // (the server orders by the range midpoint).
      columnHelper.display({
        id: "priceRange",
        header: "Price range",
        meta: {
          numeric: true,
          // Wide enough for two five-figure amounts plus the en-dash — the
          // footer totals are the longest string this column ever renders.
          className: "w-48",
          mobile: { slot: "trailing", priority: 20 },
        },
        footer: (info) => {
          // Server sums span the whole filtered set, not the loaded page —
          // never fall back to reducing the visible rows.
          const sums = info.table.options.meta?.serverTotals?.sums;
          if (!sums?.priceHigh) return null;
          return (
            <span className="font-mono text-positive tabular-nums">
              {formatCurrencyRange(sums.priceLow ?? 0, sums.priceHigh)}
            </span>
          );
        },
        cell: (info) => {
          const row = info.row.original;
          if (row.kind === "candidate") {
            return row.candidate.price === null ? (
              <NoneValue />
            ) : (
              <span className="font-mono tabular-nums">
                {formatCurrency(row.candidate.price)}
              </span>
            );
          }
          const range = wishPriceRange(row.wish.candidates);
          if (!range) return <NoneValue />;
          const unpriced = row.wish.candidates.length - range.pricedCount;
          return (
            <span
              className="font-mono tabular-nums"
              title={
                unpriced > 0
                  ? `${range.pricedCount} of ${row.wish.candidates.length} options priced`
                  : undefined
              }
            >
              {formatCurrencyRange(range.low, range.high)}
              {unpriced > 0 && <span className="text-slate">*</span>}
            </span>
          );
        },
      }),
    ],
    [columnHelper],
  );

  // Neither `buildFilters` nor `filters` is passed: the `wish` entry in
  // `entities/filter-manifest.tsx` drives the Name search box, the server
  // `WishFilters` object, and the `?q=` URL round-trip.
  const {
    table,
    data,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
    totalCount,
  } = useEntityList<WishRow, WishFilters, WishOut>({
    entity: "wish",
    queryOptions: api.wish.list.queryOptions,
    columns,
    deletable: deletableConfig,
    tree: WISH_TREE_CONFIG,
  });
  usePageCount(totalCount);

  const candidateProductIds = useMemo(
    () =>
      uniq(
        data.flatMap((wish) =>
          wish.candidates.map((candidate) => candidate.id),
        ),
      ),
    [data],
  );

  return (
    <div>
      <ProductImageSummariesProvider productIds={candidateProductIds}>
        <RTable
          table={table}
          isLoading={isLoading}
          error={error}
          ariaLabel="Wishlist Table"
          timing={timing}
          entity="wish"
          bulkActionBar={bulkActionBar}
          infiniteScroll={infiniteScroll}
          refreshControls={refreshControls}
          actions={
            <Button onClick={() => setOpen(true)}>
              <Plus /> New wish
            </Button>
          }
        />
      </ProductImageSummariesProvider>
      {deleteDialog}
      <WishFormDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function WishRowCover({ row }: { row: WishRow }) {
  return row.kind === "wish" ? (
    <WishCandidatesCover candidates={row.wish.candidates} />
  ) : (
    <CandidateCover productId={row.productId} />
  );
}

function WishCandidatesCover({
  candidates,
}: {
  candidates: WishOut["candidates"];
}) {
  const productIds = useMemo(
    () => candidates.map((candidate) => candidate.id),
    [candidates],
  );
  const images = useHydratedProductImagesForAll(productIds);
  return (
    <ImageThumbnail
      images={images}
      alt="Candidate product image"
      lazyPreview
      entity="product"
    />
  );
}

function CandidateCover({ productId }: { productId: string }) {
  const images = useHydratedProductImages(productId);
  return (
    <ImageThumbnail
      images={images}
      alt="Product image"
      lazyPreview
      entity="product"
    />
  );
}
