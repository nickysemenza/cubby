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
  useHydratedProductImagesForAll,
} from "~/app/_components/products/product-image-summaries";
import { ImageThumbnail } from "~/app/_components/table/ImageThumbnail";
import { usePageCount } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrencyRange } from "~/lib/format-range";
import { wishMutationInvalidateKeys } from "~/lib/query-keys";
import { WishFormDialog } from "./wish-form-dialog";
import { wishPriceRange } from "./wish-price-range";

export function WishList() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<WishOut>(), []);
  const [open, setOpen] = useState(false);

  const deletableConfig = useDeletableConfig({
    mutationFn: api.wish.delete.mutationOptions,
    entityLabel: "Wish",
    invalidateKeys: wishMutationInvalidateKeys,
    entity: "wish",
  });

  const columns = useMemo(
    () => [
      // Covers belong to the candidate Products, not the wish, so they're
      // fetched independently of `wish.list` (same pattern as the expense
      // ledger's product column). All of a wish's candidate images are merged
      // so the thumbnail's `+N` badge stands for "more options".
      columnHelper.accessor((row) => row.candidates, {
        id: "image",
        header: () => <ImageIcon className="size-3 text-muted-foreground" />,
        enableSorting: false,
        meta: {
          className: "h-px w-16 overflow-hidden px-0 py-0",
          mobile: { slot: "image", priority: -10 },
        },
        cell: (info) => <WishCandidateCover candidates={info.getValue()} />,
      }),
      // `id: "acquired"` matches the `wish` filter manifest's boolean spec, so
      // the header filter control is picked up automatically — see
      // `useStandardColumns`' `withManifestFilter`.
      columnHelper.accessor((row) => row.acquiredAt, {
        id: "acquired",
        header: "Status",
        meta: { className: "w-28", mobile: { slot: "trailing", priority: 10 } },
        cell: (info) =>
          info.getValue() ? (
            <Badge variant="positive">Acquired</Badge>
          ) : (
            <Badge variant="slate">Wanted</Badge>
          ),
      }),
      columnHelper.accessor((row) => row.candidates.length, {
        id: "candidateCount",
        header: "Options",
        meta: {
          numeric: true,
          className: "w-24",
          mobile: { slot: "meta", priority: 20 },
        },
        cell: (info) => (
          <span className="font-mono tabular-nums">{info.getValue()}</span>
        ),
      }),
      // Hand-rolled rather than `createCurrencyColumn`: that helper renders one
      // scalar, and both the cell and the footer here are spans. Sorting is
      // wired by `useStandardColumns` because "priceRange" is in
      // `wishSortableFields` (the server orders by the range midpoint).
      columnHelper.accessor((row) => wishPriceRange(row.candidates), {
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
          const range = info.getValue();
          if (!range) return <NoneValue />;
          const unpriced =
            info.row.original.candidates.length - range.pricedCount;
          return (
            <span
              className="font-mono tabular-nums"
              title={
                unpriced > 0
                  ? `${range.pricedCount} of ${info.row.original.candidates.length} options priced`
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
  } = useEntityList<WishOut, WishFilters>({
    entity: "wish",
    queryOptions: api.wish.list.queryOptions,
    columns,
    deletable: deletableConfig,
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

function WishCandidateCover({
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
