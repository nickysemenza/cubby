import type { WishFilters, WishListItemOut } from "@cubby/schemas/wish";
import { useQuery } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { ImageIcon } from "lucide-react";
import { useMemo } from "react";

import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import { attachCubbyColumnMeta } from "~/app/_components/data-table/table-meta";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
} from "~/app/_components/products/product-image-summaries";
import { ImageThumbnail } from "~/app/_components/table/ImageThumbnail";
import {
  buildWishRows,
  type WishRow,
  wishSubRows,
} from "~/app/wishes/wish-rows";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { relationshipFieldProvenance } from "~/entities/field-provenance";
import { formatCurrencyRange, rangeMidpoint } from "~/lib/format-range";
import { relatedData } from "~/lib/related-data.functions";
import { formatCurrency } from "~/lib/utils";

import { defineListOverride, interleaveDeclared } from "./types";

const columnHelper = createCubbyColumnHelper<WishRow>();

const WISH_STATUS_OPTIONS = [
  { value: "acquired", label: "Acquired", color: "var(--positive)" },
  { value: "wanted", label: "Wanted", color: "var(--slate)" },
];

const CANDIDATE_STOCK_OPTIONS = [
  { value: "yes", label: "In inventory", color: "var(--positive)" },
  { value: "no", label: "Not stocked", color: "var(--slate)" },
];

/** Stable empty default — `useFilterOptions` needs a referentially fixed miss. */
const NO_FILTER_OPTIONS: FilterableComboboxItem[] = [];

/**
 * The children are Products, not Wishes — a heterogeneous tree: `rowLink`
 * sends each row to its own entity's detail page, and `rowIsEntity` keeps the
 * wish-only affordances (selection, the row menu's Delete) off candidates.
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

const wishMobileDetailsHref = (row: WishRow) =>
  `/${entities[row.entityType].basePath}/${row.previewId}`;

const WISH_PREVIEW = {
  entity: null,
  idField: "previewId",
  responsiveInspector: true,
} as const;

function WishRowCover({ row }: { row: WishRow }) {
  return row.kind === "wish" ? (
    <ImageThumbnail
      // The server merges every candidate's photos in candidate order, so a
      // collapsed wish's "+N" badge reads as "more options".
      images={row.wish.displayImages}
      alt="Candidate product image"
      lazyPreview
      entity="product"
    />
  ) : (
    <CandidateCover productId={row.productId} />
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

export const wishListOverride = defineListOverride<
  WishRow,
  WishFilters,
  WishListItemOut
>({
  use() {
    // The candidate roster comes from the relation itself: only a Product
    // that is somebody's candidate can narrow this list.
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

    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<WishRow>((add) => {
          // `id: "acquired"` matches the manifest's boolean spec, so the
          // header filter control attaches. Derived, so read-only: a wish's
          // state comes from `acquiredAt`, a candidate's from whether the
          // Product is on a shelf.
          add(
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
          );
        }),
      [],
    );

    const compose = useMemo(
      () => (declared: CubbyColumnCollection<WishRow>) =>
        createCubbyColumnCollection<WishRow>((add) => {
          const { place, rest } = interleaveDeclared(declared, add);
          // Covers belong to the candidate Products, so they're fetched
          // independently of `wish.list`.
          add(
            columnHelper.display({
              id: "image",
              header: () => (
                <ImageIcon className="size-3 text-muted-foreground" />
              ),
              enableSorting: false,
              meta: {
                provenance: relationshipFieldProvenance("wish", "candidates"),
                className: "h-px w-16 overflow-hidden px-0 py-0",
                mobile: { slot: "image", priority: -10 },
              },
              cell: (info) => <WishRowCover row={info.row.original} />,
            }),
          );
          place("acquired");
          // The candidate's manufacturer/model, which tells two similarly
          // named alternatives apart. Blank on wish rows.
          add(
            columnHelper.display({
              id: "candidateSpec",
              header: "Make / model",
              meta: {
                provenance: relationshipFieldProvenance("wish", "candidates"),
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
          );
          add(
            columnHelper.accessor(
              (row) => (row.kind === "wish" ? row.wish.candidateCount : null),
              {
                id: "candidateCount",
                header: "Options",
                meta: attachCubbyColumnMeta<WishRow>({
                  provenance: relationshipFieldProvenance("wish", "candidates"),
                  numeric: true,
                  className: "w-24",
                  mobile: { slot: "meta", priority: 20 },
                  explanation: {
                    resolve: (row) =>
                      row.kind === "wish"
                        ? {
                            entity: "wish",
                            field: "candidateCount",
                            label: "Options",
                          }
                        : undefined,
                  },
                }),
                cell: (info) => {
                  const count = info.getValue();
                  if (count === null) return null;
                  return (
                    <span className="font-mono tabular-nums">{count}</span>
                  );
                },
              },
            ),
          );
          // An ACCESSOR column even though `cell` ignores the value:
          // TanStack's `getCanSort()` ands in `!!column.accessorFn`, so a
          // display column never renders a sort control. The accessor
          // returns the same midpoint the server orders by.
          add(
            columnHelper.accessor(
              (row) => {
                if (row.kind === "candidate") return row.candidate.price;
                const range = row.wish.priceRange;
                return range ? rangeMidpoint(range.low, range.high) : null;
              },
              {
                id: "priceRange",
                header: "Price range",
                meta: attachCubbyColumnMeta<WishRow>({
                  provenance: relationshipFieldProvenance("wish", "candidates"),
                  numeric: true,
                  // Wide enough for two five-figure amounts plus the en-dash.
                  className: "w-48",
                  mobile: { slot: "trailing", priority: 20 },
                  explanation: {
                    resolve: (row) =>
                      row.kind === "wish"
                        ? {
                            entity: "wish",
                            field: "priceRange",
                            label: "Price range",
                          }
                        : undefined,
                  },
                }),
                footer: (info) => {
                  // Server sums span the whole filtered set, never the page.
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
                  const range = row.wish.priceRange;
                  if (!range) return <NoneValue />;
                  const unpriced =
                    row.wish.candidates.length - range.pricedCount;
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
          );
          rest();
        }),
      [],
    );

    const list = useMemo(
      () => ({
        deletable: true as const,
        filterOptions,
        preview: WISH_PREVIEW,
      }),
      [filterOptions],
    );

    return {
      overrides,
      compose,
      tree: WISH_TREE_CONFIG,
      list,
      useWorkbench: () => ({ getMobileDetailsHref: wishMobileDetailsHref }),
      wrap: (children, { data }) => (
        <WishCoverProvider data={data}>{children}</WishCoverProvider>
      ),
    };
  },
});

function WishCoverProvider({
  data,
  children,
}: {
  data: WishListItemOut[];
  children: React.ReactNode;
}) {
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
    <ProductImageSummariesProvider productIds={candidateProductIds}>
      {children}
    </ProductImageSummariesProvider>
  );
}
