import type { WishFilters, WishOut } from "@cubby/schemas/wish";
import { useQuery } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { ImageIcon } from "lucide-react";
import { useMemo } from "react";
import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
  useHydratedProductImagesForAll,
} from "~/app/_components/products/product-image-summaries";
import { ImageThumbnail } from "~/app/_components/table/ImageThumbnail";
import { usePageCount } from "~/components/page/Page";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { NoneValue } from "~/components/ui/none-value";
import { wishCreateRequest } from "~/entities/editing/editor-requests";
import { entities, entityDetailParams } from "~/entities/entities";
import { formatCurrencyRange, rangeMidpoint } from "~/lib/format-range";
import { relatedData } from "~/lib/related-data.functions";
import { formatCurrency } from "~/lib/utils";
import { wishPriceRange } from "./wish-price-range";
import { buildWishRows, type WishRow, wishSubRows } from "./wish-rows";

const WISH_STATUS_OPTIONS = [
  { value: "acquired", label: "Acquired", color: "var(--positive)" },
  { value: "wanted", label: "Wanted", color: "var(--slate)" },
];

const CANDIDATE_STOCK_OPTIONS = [
  { value: "yes", label: "In inventory", color: "var(--positive)" },
  { value: "no", label: "Not stocked", color: "var(--slate)" },
];

/**
 * Tree config for the wishlist. Module-level so the reference is stable —
 * `useEntityList` feeds `nest` straight into a `useMemo`.
 *
 * The children are Products, not Wishes, so this is the first heterogeneous
 * tree in the repo: `rowLink` sends each row to its own entity's detail page,
 * and `rowIsEntity` keeps the wish-only affordances (selection, the row menu's
 * Delete) off candidate rows.
 */
/** Stable empty default — `useFilterOptions` needs a referentially fixed miss. */
const NO_FILTER_OPTIONS: FilterableComboboxItem[] = [];

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

const wishMobileDetailsHref = (row: WishRow) =>
  `/${entities[row.entityType].basePath}/${row.previewId}`;

export function WishList() {
  const columnHelper = useMemo(() => createCubbyColumnHelper<WishRow>(), []);
  const {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    preview,
    dockedInspector,
  } = useEntityPreview(undefined, {
    idField: "previewId",
    responsiveInspector: true,
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
          // Derived, so read-only: a wish's state comes from `acquiredAt` (a
          // timestamp) and a candidate's from whether the Product is on a shelf
          // — neither is a boolean column to write. Both branches label both
          // states; the candidate's negative case used to render `—`, which
          // claimed "unknown" about a shelf we had in fact just checked.
          cell: (info) => {
            const row = info.row.original;
            if (row.kind === "candidate") {
              return renderOptionCell(
                row.candidate.inventoried ? "yes" : "no",
                CANDIDATE_STOCK_OPTIONS,
              );
            }
            return renderOptionCell(
              row.wish.acquiredAt ? "acquired" : "wanted",
              WISH_STATUS_OPTIONS,
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
      // scalar, and a wish row's value is a span.
      //
      // An ACCESSOR column, not a display one, even though `cell` ignores the
      // value: TanStack's `getCanSort()` ands in `!!column.accessorFn`, so a
      // display column never sorts however `enableSorting` is computed — the
      // header would render no control at all. Sorting itself is manual
      // (`wishSortableFields` + `resolveWishSort`), so the accessor exists to
      // enable that control; it returns the same midpoint the server orders by
      // rather than a bound, so the two can't tell different stories.
      columnHelper.accessor(
        (row) => {
          if (row.kind === "candidate") return row.candidate.price;
          const range = wishPriceRange(row.wish.candidates);
          return range ? rangeMidpoint(range.low, range.high) : null;
        },
        {
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
        },
      ),
    ],
    [columnHelper],
  );

  // The candidate roster comes from the relation itself, not the product
  // catalog: only a Product that is somebody's candidate can narrow this list,
  // and the hint is the number of wishes naming it.
  const candidateOptionsQuery = useQuery(
    relatedData.options.queryOptions({
      relationKey: "wish.candidates",
      limit: 100,
    }),
  );
  const filterOptions = useFilterOptions({
    wishCandidates:
      candidateOptionsQuery.data?.map(({ id, label, count }) => ({
        value: id,
        label,
        hint: String(count),
      })) ?? NO_FILTER_OPTIONS,
  });

  // Neither `buildFilters` nor `filters` is passed: the `wish` entry in
  // `entities/filter-manifest.tsx` drives the Name search box, the server
  // `WishFilters` object, and the `?q=` URL round-trip.
  const { workbench, data, totalCount } = useEntityList<
    WishRow,
    WishFilters,
    WishOut
  >({
    entity: "wish",
    columns,
    // The wish contract's own list query, delete, and invalidation fan-out.
    deletable: true,
    tree: WISH_TREE_CONFIG,
    filterOptions,
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

  // Not `EntityListPage`: this list reads the hook's `data` to collect its
  // candidate product ids, and wraps the workbench in the image-summary
  // provider those covers read from.
  return (
    <div>
      <ProductImageSummariesProvider productIds={candidateProductIds}>
        <ListWorkbench
          model={workbench}
          ariaLabel="Wishlist Table"
          actions={
            <CreateDialogAction request={wishCreateRequest()}>
              New wish
            </CreateDialogAction>
          }
          onRowClick={onRowClick}
          onRowHover={onRowHover}
          onRowHoverEnd={onRowHoverEnd}
          currentRowId={preview?.rowKey ?? preview?.id}
          defaultDensity="dense"
          desktopInspector={dockedInspector}
          getMobileDetailsHref={wishMobileDetailsHref}
        />
        <PreviewSheet />
      </ProductImageSummariesProvider>
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
