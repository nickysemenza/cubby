import { displayGtin } from "@cubby/schemas/external-id";
import {
  productCategory,
  productCategoryValues,
  type ProductFilters,
  type ProductListItem,
} from "@cubby/schemas/product";
import type { KitComponentRowOut } from "@cubby/schemas/product-components";
import { formatCategoryLabel, getCategoryColor } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import { CalendarClock, Rows3, Table2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { VerbMenuItem } from "~/app/_components/actions/action-verb-ui";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import {
  ProductFoodSummariesProvider,
  useHydratedProductFood,
  useProductFoodSummaries,
} from "~/app/_components/products/product-food-summaries";
import { UnitPriceLine } from "~/app/_components/units/unit-price-line";
import { product as productOperations } from "~/app/products/product.functions";
import { Stack } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { NoneValue } from "~/components/ui/none-value";
import { OptionalStatusText, StatusText } from "~/components/ui/status-text";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import type { ViewSwitcherOption } from "~/components/ui/view-switcher";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import {
  createEntityDisplayColumns,
  entityListHiddenColumns,
} from "~/entities/entity-display";
import { entityListFor } from "~/entities/entity-list.functions";
import { dataQualityOptions } from "~/lib/data-quality-options";
import { relatedData } from "~/lib/related-data.functions";
import { booleanCellOptions, presenceCellOptions } from "~/lib/select-options";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { formatCurrency } from "~/lib/utils";
import { wasm } from "~/lib/wasm";

import { WithEntitySearch } from "../_components/combobox/with-search-hook";
import {
  createBooleanColumn,
  createCurrencyColumn,
  createExternalLinkColumn,
  createFilterableSelectColumn,
  createInventoryEntriesColumn,
  createPlainDateColumn,
  createSingleEntityInlineLinkColumn,
  createTextColumn,
  productPriceClearLabel,
  renderOptionCell,
  renderProductPriceValue,
} from "../_components/data-table/columnHelpers";
import { DataTableToolbar } from "../_components/data-table/data-table-toolbar";
import { EditableCell } from "../_components/data-table/editable-cell";
import { ListWorkbench } from "../_components/data-table/ListWorkbench";
import type { GroupConfig } from "../_components/data-table/useGroupedList";
import { EntityInlineLink } from "../_components/EntityInlineLink";
import { useDeferredFilterOptions } from "../_components/hooks/useDeferredFilterOptions";
import { useEntityList } from "../_components/hooks/useEntityList";
import type { EntityPreviewRendererProps } from "../_components/hooks/useEntityPreview";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import type { ListQueryOptionsFn } from "../_components/hooks/usePaginatedTableCore";
import { useProductTagOptions } from "../_components/hooks/useProductTagOptions";
import { useSeededFilter } from "../_components/hooks/useSeededFilter";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { useCreateInventoryMutation } from "../_components/inventory/hooks";
import { InventoryEntriesQuickEditDialog } from "../_components/inventory/inventory-entries-quick-edit-dialog";
import { CategoryLabel } from "../_components/products/CategoryLabel";
import { productCategoryOptionsWithTheme } from "../_components/products/product-category-icons";
import { ProductDiscardDialog } from "../_components/products/product-discard-dialog";
import { ProductShelf } from "../_components/products/product-shelf";
import { ProductWorkbenchInspector } from "../_components/products/product-workbench-inspector";
import { EntityTimeline } from "../_components/timeline/entity-timeline";
import { TruncatedList } from "../_components/TruncatedList";
import {
  buildProductTreeRows,
  groupComponentsByParent,
  isKitComponentRow,
  type ProductTreeRow,
  productTreeRowKey,
  productTreeSubRows,
} from "./product-kit-rows";

export type ProductListView = "table" | "shelf" | "timeline";

export const PRODUCT_VIEW_OPTIONS: ViewSwitcherOption<ProductListView>[] = [
  { value: "table", label: "Table", icon: Table2 },
  { value: "shelf", label: "Shelf", icon: Rows3 },
  { value: "timeline", label: "Timeline", icon: CalendarClock },
];

interface ProductListProps {
  initialCategory?: string;
  view: ProductListView;
}

// A module-level fallback keeps the runtime options reference stable while the
// roster query is loading (and avoids turning every table render into a new
// filter configuration).
const NO_VENDOR_OPTIONS: FilterableComboboxItem[] = [];
const NO_FILTER_OPTIONS: FilterableComboboxItem[] = [];
/** Stable empty default so `nest` keeps its identity while kits load. */
const EMPTY_KIT_ROWS: KitComponentRowOut[] = [];
const productListQueryOptions: ListQueryOptionsFn<
  ProductFilters,
  ProductListItem
> = (params) => entityListFor("product").listQueryPlan(params);

function renderProductInspector({
  preview,
  onClose,
}: EntityPreviewRendererProps) {
  return <ProductWorkbenchInspector productId={preview.id} onClose={onClose} />;
}

// The generic tones fit here: tracked really is the resolved/good outcome.
const STOCK_TRACKED_OPTIONS = booleanCellOptions({
  true: "Tracked",
  false: "Not tracked",
});

const MODEL_PRESENCE_OPTIONS = presenceCellOptions("model");
const UPC_PRESENCE_OPTIONS = presenceCellOptions("UPC");
const NOTES_PRESENCE_OPTIONS = presenceCellOptions("notes");

function renderNotesValue(notes: string | null): ReactNode {
  if (!notes) return <NoneValue />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="block truncate text-muted-foreground" />}
      >
        {notes}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {notes}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Units bought minus units gone, with its own uncertainty attached.
 *
 * The `+N?` / `−N?` suffixes are load-bearing rather than decorative: an
 * expense line with no recorded quantity contributes nothing to the number, so
 * a product with six unquantified receipts would otherwise read as a confident
 * 0. Same shape as `knownAcquiredUnits` in relationship-summary-table, and both
 * directions are disclosed — an unknown acquisition means the real count could
 * be higher, an unknown exit that it could be lower.
 */
function ExpectedQuantityCell({
  ledger,
}: {
  ledger: ProductListItem["quantityLedger"];
}) {
  const detail = [
    `${ledger.acquiredUnits} acquired − ${ledger.exitedUnits} gone`,
    ledger.unknownAcquisitionLines > 0
      ? `${ledger.unknownAcquisitionLines} acquisition line(s) carry no quantity`
      : null,
    ledger.unknownExitLines > 0
      ? `${ledger.unknownExitLines} exit line(s) carry no quantity`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="tabular-nums" />}>
        <OptionalStatusText
          tone={ledger.expectedQuantity < 0 ? "destructive" : undefined}
        >
          {ledger.expectedQuantity}
        </OptionalStatusText>
        {ledger.unknownAcquisitionLines > 0 ? (
          <StatusText tone="warning">
            {` +${ledger.unknownAcquisitionLines}?`}
          </StatusText>
        ) : null}
        {ledger.unknownExitLines > 0 ? (
          <StatusText tone="warning">
            {` −${ledger.unknownExitLines}?`}
          </StatusText>
        ) : null}
      </TooltipTrigger>
      <TooltipContent side="top">{detail}</TooltipContent>
    </Tooltip>
  );
}

function ProductFoodCell({ product }: { product: ProductListItem }) {
  const food = useHydratedProductFood(product);
  return food ? (
    <EntityInlineLink
      displayImage={undefined}
      entity="usda-food"
      data={food}
      compact
    />
  ) : (
    <NoneValue />
  );
}

const productsRoute = getRouteApi("/_authenticated/products/");

/** The Timeline view: `resources.product.timeline` over the current filters, window in the search keys. */
function ProductTimelineView({ filters }: { filters: ProductFilters }) {
  const search = productsRoute.useSearch();
  const navigate = productsRoute.useNavigate();
  return (
    <EntityTimeline
      entity="product"
      filters={filters}
      from={search.timelineFrom}
      to={search.timelineTo}
      order={search.timelineOrder ?? "desc"}
      mode={search.timelineMode ?? "events"}
      onControlsChange={(patch) =>
        navigate({
          search: (previous) => {
            const next = { ...previous };
            if ("from" in patch) next.timelineFrom = patch.from;
            if ("to" in patch) next.timelineTo = patch.to;
            if ("order" in patch) next.timelineOrder = patch.order;
            if ("mode" in patch) next.timelineMode = patch.mode;
            return next;
          },
          replace: true,
        })
      }
    />
  );
}

export function ProductList({ initialCategory, view }: ProductListProps) {
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<ProductTreeRow>(),
    [],
  );
  // Runtime picklist for the manifest's `tags` spec (optionsKey: "tags").
  const { options: tagOptions } = useProductTagOptions();
  const projectOptions = useDeferredFilterOptions("project");
  const locationOptions = useDeferredFilterOptions("locationWithInventory");
  const ingredientOptions = useDeferredFilterOptions("ingredientWithProduct");
  const manufacturerOptionsQuery = useQuery(
    productOperations.manufacturerOptions.queryOptions(),
  );
  const externalIdSourceOptionsQuery = useQuery(
    productOperations.externalIdSourceOptions.queryOptions(),
  );
  const manufacturerOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      manufacturerOptionsQuery.data?.map(({ manufacturer, count }) => ({
        value: manufacturer,
        label: manufacturer,
        hint: String(count),
      })) ?? NO_FILTER_OPTIONS,
    [manufacturerOptionsQuery.data],
  );
  const externalIdSourceOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      externalIdSourceOptionsQuery.data?.map(({ source, count }) => ({
        value: source,
        label: source,
        hint: String(count),
      })) ?? NO_FILTER_OPTIONS,
    [externalIdSourceOptionsQuery.data],
  );
  // The graph owns this picklist too: its count is distinct matching Products,
  // not the Vendor roster's purchase-count hint. Keeping the query keyed by
  // `product.vendors` also ensures only Vendors that can match a Product are
  // offered here.
  const vendorOptionsQuery = useQuery(
    relatedData.options.queryOptions({
      relationKey: "product.vendors",
      limit: 100,
    }),
  );
  const purchaseOptionsQuery = useQuery(
    relatedData.options.queryOptions({
      relationKey: "product.purchases",
      limit: 100,
    }),
  );
  const vendorOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      vendorOptionsQuery.data?.map(({ id, label, count }) => ({
        value: id,
        label,
        hint: String(count),
      })) ?? NO_VENDOR_OPTIONS,
    [vendorOptionsQuery.data],
  );
  const purchaseOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      purchaseOptionsQuery.data?.map(({ id, label, count }) => ({
        value: id,
        label,
        hint: String(count),
      })) ?? NO_FILTER_OPTIONS,
    [purchaseOptionsQuery.data],
  );
  const filterOptions = useFilterOptions({
    tags: tagOptions,
    productVendors: vendorOptions,
    project: projectOptions,
    productLocations: locationOptions,
    productIngredients: ingredientOptions,
    manufacturers: manufacturerOptions,
    productPurchases: purchaseOptions,
    externalIdSources: externalIdSourceOptions,
  });
  const [foodHydrationIds, setFoodHydrationIds] = useState<readonly string[]>(
    [],
  );
  const foodByProductId = useProductFoodSummaries(foodHydrationIds);

  const updateProductMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("product", "update"),
    entity: "product",
  });

  const updateInventoryMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("inventory", "update"),
    entity: "inventory",
  });
  const createInventoryMutation = useCreateInventoryMutation();

  const nameEditable = useNameEditable<ProductTreeRow>(
    updateProductMutation.mutateAsync,
  );

  // Quick-edit dialog for a row's inventory entries; track the id and derive
  // the product from live list data so post-save invalidation refreshes the
  // open dialog too.
  const [quickEditProductId, setQuickEditProductId] = useState<string | null>(
    null,
  );
  // Same live-data lookup as quickEdit above: the dialog reads the row out of
  // list data, so post-discard invalidation refreshes what it is showing.
  const [discardProductId, setDiscardProductId] = useState<string | null>(null);

  const tableStateOptions = useSeededFilter("category", initialCategory);

  const getProductListMappings = useCallback(
    (product: ProductListItem) =>
      getAllUnitMappingsFromProduct({
        ...product,
        food: foodByProductId[product.id] ?? null,
      }),
    [foodByProductId],
  );

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<ProductTreeRow>((add) => {
        // The product declaration owns column membership/order for every
        // `display.list` field (docs/entities.md's "declaration wins" rule);
        // this collection supplies the specialized renderers as overrides
        // matched by column id, keeping each existing cell exactly as it was.
        const overrides = createCubbyColumnCollection<ProductTreeRow>((add) => {
          add(
            createFilterableSelectColumn(columnHelper, "category", {
              header: "Category",
              className: "w-32",
              placeholder: "Filter by category...",
              selectOptions: productCategoryOptionsWithTheme,
              renderCell: (cat) => <CategoryLabel category={cat} />,
              // Mobile lists group by category (section headers), so the category
              // chip is redundant per-row — prefer manufacturer as the subtitle.
              mobile: { slot: "subtitle", priority: 30 },
              editable: {
                parseValue: (value) => productCategory.nullable().parse(value),
                onSave: async (newCategory, product) => {
                  await updateProductMutation.mutateAsync({
                    id: product.id,
                    data: { category: newCategory },
                  });
                },
              },
            }),
          );
          add(
            createTextColumn(columnHelper, "manufacturer", {
              header: "Manufacturer",
              className: "min-w-0 w-40 truncate",
              mobile: { slot: "subtitle", priority: 20 },
              editable: {
                onSave: async (newValue, product) => {
                  await updateProductMutation.mutateAsync({
                    id: product.id,
                    data: { manufacturer: newValue ?? "" },
                  });
                },
              },
            }),
          );
          add(
            columnHelper.accessor("primaryGtin", {
              header: "Barcode / ISBN",
              meta: {
                className: "w-32 font-mono",
                mobile: { interactive: true },
              },
              cell: (info) => {
                const value = info.getValue();
                return (
                  <EditableCell
                    value={value}
                    onSave={async (newValue) => {
                      await updateProductMutation.mutateAsync({
                        id: info.row.original.id,
                        data:
                          newValue != null &&
                          wasm.normalize_isbn(newValue) != null
                            ? { isbn: newValue }
                            : { upc: newValue },
                      });
                    }}
                    config={{ type: "text" }}
                    trigger="pencil"
                    renderValue={(current) => {
                      if (!current) return <NoneValue />;
                      const isbn = wasm.isbn_from_gtin(current);
                      if (isbn) {
                        return (
                          <span className="font-mono tabular-nums">
                            {isbn.isbn13}
                          </span>
                        );
                      }
                      const shown = displayGtin(current);
                      return (
                        <Link
                          to="/usda/upc/$code"
                          params={{ code: shown }}
                          className="text-primary hover:underline"
                        >
                          {shown}
                        </Link>
                      );
                    }}
                  />
                );
              },
            }),
          );
          add(
            createExternalLinkColumn(columnHelper, "fdc_id", "/usda/$id", {
              header: "FDC",
              className: "w-32",
              editable: {
                onSave: async (newValue, product) => {
                  await updateProductMutation.mutateAsync({
                    id: product.id,
                    data: { fdc_id: newValue ? Number(newValue) : null },
                  });
                },
              },
            }),
          );
          add(
            createTextColumn(columnHelper, "model", {
              className: "min-w-0 w-40 truncate",
              editable: {
                onSave: async (newValue, product) => {
                  await updateProductMutation.mutateAsync({
                    id: product.id,
                    data: { model: newValue },
                  });
                },
              },
            }),
          );
          add(
            createTextColumn(columnHelper, "notes", {
              header: "Notes",
              className: "min-w-0 w-40",
              renderValue: renderNotesValue,
              editable: {
                onSave: async (newNotes, product) => {
                  await updateProductMutation.mutateAsync({
                    id: product.id,
                    data: { notes: newNotes },
                  });
                },
              },
            }),
          );
          // Editable, and tri-state on purpose. `null` is the undecided backlog the
          // "Products the ledger says you own" saved view filters on, so this cell is
          // where that view gets worked: decide a row and it leaves the view. Before
          // this the field had no UI surface at all — not here, not the detail page,
          // not the product form — so the only way to answer the worklist's question
          // was MCP.
          add(
            createBooleanColumn(columnHelper, "stockTracked", {
              header: "Stock tracking",
              className: "w-28",
              placeholder: "Filter stock tracking...",
              trueFalseOptions: STOCK_TRACKED_OPTIONS,
              undecided: { label: "Undecided" },
              // The header control stays the manifest's presence filter (undecided vs
              // reviewed) — that is what backs the worklist view, and it asks a
              // different question than tracked-vs-untracked.
              filterConfig: null,
              editable: {
                onSave: async (stockTracked, product) => {
                  await updateProductMutation.mutateAsync({
                    id: product.id,
                    data: { stockTracked },
                  });
                },
              },
            }),
          );
          add(
            columnHelper.accessor((row) => row.dataQuality.status, {
              id: "dataQuality",
              header: "Data quality",
              enableSorting: false,
              meta: {
                className: "w-28",
                mobile: { slot: "meta", priority: 75 },
              },
              cell: (info) =>
                renderOptionCell(info.getValue(), dataQualityOptions),
            }),
          );
          add(
            columnHelper.accessor("externalIds", {
              id: "externalIds",
              header: "External IDs",
              enableSorting: false,
              meta: {
                className: "w-36",
                mobile: { slot: "meta", priority: 85 },
              },
              cell: (info) => {
                const ids = info.getValue();
                if (!ids.length) return <NoneValue />;
                return (
                  <span className="text-xs text-muted-foreground">
                    {ids.map((externalId) => externalId.source).join(", ")}
                  </span>
                );
              },
            }),
          );
          add(
            columnHelper.accessor((product) => product.pricing.effectivePrice, {
              id: "price",
              // A header FUNCTION, not a plain string: `createEntityDisplayColumns`
              // always replaces a plain-string override header with the declared
              // label, and that label stays "Valuation price" for the detail
              // page's sake (see the entity declaration). A function is the one
              // shape it lets through unreplaced, so the list still heads this
              // "Price" as it always has.
              header: () => "Price",
              meta: {
                numeric: true,
                className: "w-20",
                mobile: { slot: "trailing", priority: 10, interactive: true },
              },
              footer: (info) => {
                const total =
                  info.table.options.meta?.serverTotals?.sums?.price;
                return total ? (
                  <span className="font-mono text-positive tabular-nums">
                    {formatCurrency(total)}
                  </span>
                ) : null;
              },
              cell: (info) => {
                const product = info.row.original;
                return (
                  <EditableCell
                    value={product.price}
                    onSave={async (price) => {
                      await updateProductMutation.mutateAsync({
                        id: product.id,
                        data: { price },
                      });
                    }}
                    config={{
                      type: "currency",
                      clearable: {
                        label: productPriceClearLabel(product.pricing),
                      },
                    }}
                    renderValue={() => renderProductPriceValue(product.pricing)}
                  />
                );
              },
            }),
          );
          // Net cost basis — SUM(cost) over this product's live expenses, so an
          // exit (a sale booked as a negative row) telescopes against its
          // acquisition. Hidden by default via `initialColumnVisibility`: the table
          // is already wide and `price` covers the common case, but it's a real
          // column so the number is visible rather than only sortable.
          add(
            createCurrencyColumn(columnHelper, "expenseTotal", {
              header: "Net basis",
              className: "w-28",
              signedTone: true,
              mobile: { slot: "trailing", priority: 5 },
            }),
          );
          // Bins in service. Free to render — `quantityLedger` is already on every
          // list row — and it gives the "is a location" presence filter a column to
          // hang on, without which the manifest spec would render nothing.
          //
          // Renders a literal `0`, not a dash: `locationCount` is a count, never
          // null, so "no bins in service" is a known fact and the dash would claim
          // the opposite. See `view-manifest.ts`, which declines to reveal a column
          // for exactly this reason — "a dash reads as 'unknown' when the actual
          // fact is 'none'".
          add(
            columnHelper.accessor((row) => row.quantityLedger.locationCount, {
              id: "servingAsLocations",
              header: "In service",
              meta: {
                numeric: true,
                className: "w-24",
                mobile: { slot: "meta", priority: 43 },
              },
              cell: (info) => info.getValue(),
            }),
          );
          // What this product is made of. Non-zero means it's a kit, which is the
          // column the "Is a kit" manifest spec hangs on — without it the spec
          // would render nothing at all, silently.
          //
          // Renders a literal `0` for the same reason `servingAsLocations` does:
          // `componentCount` is a count and never null, so "contains nothing" is a
          // known fact and a dash would claim it's unknown.
          add(
            columnHelper.accessor((row) => row.componentCount, {
              id: "components",
              header: "Components",
              meta: {
                numeric: true,
                className: "w-28",
                mobile: { slot: "meta", priority: 44 },
              },
              cell: (info) => info.getValue(),
            }),
          );
          add(
            columnHelper.accessor(
              (row) => row.quantityLedger.expectedQuantity,
              {
                id: "expectedQuantity",
                header: "Expected",
                meta: {
                  numeric: true,
                  className: "w-24",
                  mobile: { slot: "meta", priority: 45 },
                },
                cell: (info) => (
                  <ExpectedQuantityCell
                    ledger={info.row.original.quantityLedger}
                  />
                ),
              },
            ),
          );
          // Shelf minus ledger. Dashes when the product isn't stocked, and when its
          // entries carry more than one unit (see `deriveOnHandUnits`).
          add(
            columnHelper.accessor((row) => row.quantityVariance, {
              id: "quantityVariance",
              header: "Variance",
              meta: {
                numeric: true,
                className: "w-24",
                mobile: { slot: "meta", priority: 44 },
              },
              cell: (info) => {
                const { quantityVariance, onHandUnits, quantityLedger } =
                  info.row.original;
                if (quantityVariance === null || onHandUnits === null) {
                  return <NoneValue />;
                }
                return (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        // Plain when they agree — a toneless `StatusText` would dim
                        // the number to the secondary tier (see OptionalStatusText).
                        quantityVariance === 0 ? (
                          <span className="tabular-nums" />
                        ) : (
                          <StatusText
                            as="span"
                            tone="warning"
                            className="tabular-nums"
                          />
                        )
                      }
                    >
                      {quantityVariance > 0
                        ? `+${quantityVariance}`
                        : quantityVariance}
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {`${onHandUnits} on hand vs. ${quantityLedger.expectedQuantity} expected`}
                    </TooltipContent>
                  </Tooltip>
                );
              },
            }),
          );
          add(
            createPlainDateColumn(columnHelper, "purchaseDate", {
              header: "Purchase date",
              className: "w-32",
              mobile: { slot: "meta", priority: 55 },
            }),
          );
          // Read-only: the Tags filter spec declares `columnId: "tags"`, and the
          // header-filter machinery needs a real column to hang that control on —
          // without it the table logs `Column with id 'tags' does not exist` and
          // the filter is only reachable by hand-editing the URL. Editing stays in
          // the product form / detail page rather than an inline array editor.
          add(
            columnHelper.accessor("tags", {
              id: "tags",
              header: "Tags",
              meta: {
                className: "w-40",
                mobile: { slot: "meta", priority: 60 },
              },
              cell: (info) => {
                const tags = info.getValue();
                if (!tags.length) return <NoneValue />;
                return (
                  <TruncatedList
                    items={tags}
                    maxItems={2}
                    // Each chip filters the list to its own tag — the fastest way to
                    // get from "this thing is tagged" to "everything it fits".
                    // `stopPropagation` because this table's rows carry
                    // `useEntityPreview`'s onRowClick, and TanStack's Link
                    // preventDefaults without stopping propagation — so without it the
                    // chip would navigate AND open the row's preview sheet. Same guard
                    // as the expenses link below.
                    renderItem={(tag) => (
                      <Link
                        key={tag}
                        to="/products"
                        search={{ tags: tag }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Badge variant="outline">{tag}</Badge>
                      </Link>
                    )}
                  />
                );
              },
            }),
          );
          add(
            columnHelper.accessor("expenseCount", {
              id: "expenses",
              header: "Expenses",
              // The column id is `expenses` while the row field is `expenseCount`,
              // and the id is the half that must not move: it is persisted per-user
              // in the `table-columns:product` localStorage key, so renaming it would
              // reset everyone's column layout for a count. The other two sides are
              // spelled to match it — `"expenses"` in `productSortableFields`
              // (packages/schemas/src/product.ts) and the `sort.orderBy === "expenses"`
              // branch in repo/product/crud.ts — because `buildOrderBy` drops a sort
              // whose field it does not recognize while the header still renders a
              // clickable affordance. `sort-application.integration.test.ts` carries
              // the id→field mapping in FIELD_ALIASES and now proves the sort works.
              enableSorting: true,
              meta: {
                numeric: true,
                className: "w-24",
                mobile: { slot: "meta", priority: 50, interactive: true },
              },
              cell: (info) => {
                const count = info.getValue();
                if (!count) return <NoneValue />;
                return (
                  <Link
                    to="/expenses"
                    search={{ productId: info.row.original.id }}
                    className="font-mono text-primary tabular-nums transition-colors hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {count}
                  </Link>
                );
              },
            }),
          );
        });
        const declared = createEntityDisplayColumns<ProductTreeRow>(
          "product",
          columnHelper,
          overrides,
        );
        const placedDeclaredIds = new Set<string>();
        const placeDeclared = (id: string) => {
          placedDeclaredIds.add(id);
          declared.filter((column) => column.id === id).visit(add);
        };

        // Interleaved with the declared columns above to reproduce today's
        // exact column order: these five aren't scalars of the product row
        // (a relation, computed presence flags, a client-hydrated value, a
        // second projection hosting a filter control), so they stay explicit
        // `add()`s per docs/entities.md's third bucket.
        placeDeclared("category");
        add(
          createSingleEntityInlineLinkColumn(
            columnHelper,
            "ingredient",
            "ingredient",
            {
              header: "Ingredient",
              className: "w-32",
              mobile: { slot: "meta", priority: 45, interactive: true },
              enableSorting: true,
              editable: {
                onSave: async (newIngredientId, product) => {
                  await updateProductMutation.mutateAsync({
                    id: product.id,
                    data: { ingredientId: newIngredientId },
                  });
                },
                clearable: true,
              },
            },
          ),
        );
        placeDeclared("manufacturer");
        placeDeclared("primaryGtin");
        placeDeclared("fdc_id");
        placeDeclared("model");
        placeDeclared("notes");
        add(
          columnHelper.accessor((row) => row.model, {
            id: "modelPresence",
            header: "Model present",
            enableSorting: false,
            meta: { className: "w-24" },
            cell: (info) =>
              renderOptionCell(
                info.getValue() ? "yes" : "no",
                MODEL_PRESENCE_OPTIONS,
              ),
          }),
        );
        add(
          columnHelper.accessor((row) => row.primaryGtin, {
            id: "upcPresence",
            header: "UPC present",
            enableSorting: false,
            meta: { className: "w-24" },
            cell: (info) =>
              renderOptionCell(
                info.getValue() ? "yes" : "no",
                UPC_PRESENCE_OPTIONS,
              ),
          }),
        );
        add(
          columnHelper.accessor((row) => row.notes, {
            id: "notesPresence",
            header: "Notes present",
            enableSorting: false,
            meta: { className: "w-24" },
            cell: (info) =>
              renderOptionCell(
                info.getValue() ? "yes" : "no",
                NOTES_PRESENCE_OPTIONS,
              ),
          }),
        );
        placeDeclared("stockTracked");
        placeDeclared("dataQuality");
        add(
          columnHelper.accessor((row) => row.dataQuality.gaps, {
            id: "dataGaps",
            header: "Data gaps",
            enableSorting: false,
            meta: { className: "w-36", mobile: { slot: "meta", priority: 80 } },
            cell: (info) => {
              const gaps = info.getValue();
              if (!gaps.length) return <NoneValue />;
              return (
                <span className="text-xs text-muted-foreground">
                  {gaps.map((gap) => gap.check.replaceAll("_", " ")).join(", ")}
                </span>
              );
            },
          }),
        );
        placeDeclared("externalIds");
        placeDeclared("price");
        // Comparable unit price — what the price works out to per ounce (or per
        // fl oz / each, whichever this product's conversion graph can reach).
        // A 32 oz bag at $2.73 reads $0.085/oz, which is the number that makes
        // an organic bag and a conventional one comparable at a glance.
        //
        // Deliberately a DISPLAY column, not an accessor: the value is derived
        // client-side from the loaded page, so a sortable header would order only
        // the rows in front of you and read as a catalog-wide sort. Making it
        // truly sortable needs a persisted projection — the shape
        // `ProductConversionCoverage` already uses. Display-only also keeps it
        // clear of the `row._valuesCache` trap, since an accessor's value is
        // cached against `data` alone and would go stale when a mapping changes.
        add(
          columnHelper.display({
            id: "unitPrice",
            header: "Unit price",
            meta: { numeric: true, className: "w-24" },
            cell: (info) => (
              <UnitPriceLine
                mappings={getProductListMappings(info.row.original)}
                compact
              />
            ),
          }),
        );
        placeDeclared("expenseTotal");
        placeDeclared("servingAsLocations");
        placeDeclared("components");
        placeDeclared("expectedQuantity");
        placeDeclared("quantityVariance");
        placeDeclared("purchaseDate");
        add(
          columnHelper.display({
            id: "food",
            header: "USDA Food",
            meta: {
              className: "w-32",
              // No mobile slot on purpose. This is a display column, so the
              // model's empty-value check can't reach it, and most products have
              // no USDA link — it rendered a "USDA Food —" line on nearly every
              // row. (It had been declared but silently swallowed by a deny-list
              // until that ordering was fixed; the declaration was aspirational.)
            },
            cell: ({ row }) => <ProductFoodCell product={row.original} />,
          }),
        );
        add(
          createInventoryEntriesColumn(
            columnHelper,
            "inventoryEntry",
            "location",
            (e) => e.location,
            {
              id: "location",
              enableSorting: true,
              mobile: { slot: "meta", priority: 40, interactive: true },
              onQuickEdit: (product) => setQuickEditProductId(product.id),
              inlineEdit: {
                SearchProvider: (props) => (
                  <WithEntitySearch entity="location" {...props} />
                ),
                onMoveEntry: async (entry, locationId) => {
                  await updateInventoryMutation.mutateAsync({
                    id: entry.id,
                    data: { locationId },
                  });
                },
                onCreateEntry: async (product, locationId) => {
                  await createInventoryMutation.mutateAsync({
                    productId: product.id,
                    locationId,
                    amount: { value: 1, unit: "each" },
                  });
                },
              },
            },
          ),
        );
        placeDeclared("tags");
        placeDeclared("expenses");
        // Two dormant `list: true` declarations with no page renderer before
        // this migration (`usdaUnavailable`, and `onHandUnits` — new, never
        // its own column) — generic, and hidden by default below, same as
        // the task entity's `dueEndDate`/`sortOrder`.
        declared
          .filter((column) => !placedDeclaredIds.has(String(column.id)))
          .visit(add);
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- mutations change every render but are functionally stable
    [columnHelper],
  );

  // Memoize filters to prevent recreating on every render
  const extraActions = useCallback(
    (row: ProductTreeRow) => (
      <>
        <VerbMenuItem
          verb="editLocations"
          onSelect={() => setQuickEditProductId(row.id)}
        />
        <VerbMenuItem
          verb="discard"
          onSelect={() => setDiscardProductId(row.id)}
        />
      </>
    ),
    [],
  );

  const groupKeyFn = useCallback(
    (item: ProductTreeRow) => formatCategoryLabel(item.category),
    [],
  );
  const groupColorFn = useCallback((key: string) => {
    const category = productCategoryValues.find(
      (candidate) => formatCategoryLabel(candidate) === key,
    );
    return getCategoryColor(category ?? null);
  }, []);
  const groupConfig = useMemo(
    (): GroupConfig<ProductTreeRow> => ({
      field: "category",
      keyFn: groupKeyFn,
      colorFn: groupColorFn,
    }),
    [groupKeyFn, groupColorFn],
  );

  // Kits on the currently loaded pages. Fetched for the whole page rather than
  // per expanded row: on a typical page there are none (21 kits across 5,614
  // products), and fetching on expand would deliver children AFTER render,
  // where `DesktopDataRow`'s memo — which compares `row.original` — cannot see
  // them without a `rowContentVersion` bump. Nesting before rows are built
  // sidesteps that class of bug rather than managing it.
  const [kitIds, setKitIds] = useState<string[]>([]);
  const kitComponentsQuery = useQuery({
    ...productOperations.kitComponentRows.queryOptions({
      parentProductIds: kitIds,
    }),
    enabled: kitIds.length > 0,
  });
  const componentsByParent = useMemo(
    () => groupComponentsByParent(kitComponentsQuery.data ?? EMPTY_KIT_ROWS),
    [kitComponentsQuery.data],
  );
  const productTree = useMemo(
    () => ({
      nest: (rows: ProductListItem[]) =>
        buildProductTreeRows(rows, componentsByParent),
      getSubRows: productTreeSubRows,
      expandable: true,
      // `id` stays the real shortcode at both depths, so uniqueness lives here
      // instead — see `ProductTreeRow.rowKey` for why that split matters.
      rowKey: productTreeRowKey,
      // A component IS a Product, so it would pass as this table's entity — but
      // bulk delete and the row menu act on a whole selection, and a component
      // is shown here as part of its kit rather than in its own right. Its
      // affordances live one click away on its own page.
      rowIsEntity: (row: ProductTreeRow) => !isKitComponentRow(row),
    }),
    [componentsByParent],
  );

  const { workbench, data, totalCount, currentFilters, inspection } =
    useEntityList<ProductTreeRow, ProductFilters, ProductListItem>({
      entity: "product",
      queryOptions: productListQueryOptions,
      preview: {
        responsiveInspector: true,
        renderInspector: renderProductInspector,
      },
      getMappings: getProductListMappings,
      tableStateOptions,
      columns,
      // The product contract's own delete and invalidation fan-out.
      deletable: true,
      filterOptions,
      extraActions,
      nameEditable,
      // `dataGaps`/`modelPresence`/`upcPresence`/`notesPresence` are
      // filter-hosting synthetic columns and `components` is a relation
      // column — none has a matching `model.fields` entry, so they stay
      // hand-declared here. Every other key below is declared
      // `display.listHidden` on `00-product.entity.ts` now.
      initialColumnVisibility: {
        dataGaps: false,
        modelPresence: false,
        upcPresence: false,
        notesPresence: false,
        components: false,
        ...entityListHiddenColumns("product"),
      },
      groupConfig,
      tree: productTree,
    });
  const {
    onRowClick: selectPreview,
    onRowHover,
    onRowHoverEnd,
    preview,
    PreviewSheet,
    dockedInspector,
    inspectorToggle,
  } = inspection;
  usePageCount(totalCount);

  // Same shape as the food-hydration effect below: derive the id set from the
  // loaded rows, and keep the previous array when it hasn't changed so the
  // query key stays stable across renders.
  useEffect(() => {
    const nextKitIds = uniq(
      data.filter((product) => product.componentCount > 0).map((p) => p.id),
    ).sort();
    setKitIds((current) =>
      current.length === nextKitIds.length &&
      current.every((id, index) => id === nextKitIds[index])
        ? current
        : nextKitIds,
    );
  }, [data]);

  // The Shelf view has no nesting, so it shows products only — a component
  // expanded in the table is not a second thing on the shelf.
  const items = workbench.table
    .getRowModel()
    .rows.map((r) => r.original)
    .filter((row) => !isKitComponentRow(row));
  const discardProduct = discardProductId
    ? (data.find((p) => p.id === discardProductId) ?? null)
    : null;
  const quickEditProduct = quickEditProductId
    ? (data.find((p) => p.id === quickEditProductId) ?? null)
    : null;
  const productIds = useMemo(() => data.map((product) => product.id), [data]);
  useEffect(() => {
    const nextIds = uniq(productIds).sort();
    setFoodHydrationIds((currentIds) => {
      if (
        currentIds.length === nextIds.length &&
        currentIds.every((id, index) => id === nextIds[index])
      ) {
        return currentIds;
      }
      return nextIds;
    });
  }, [productIds]);

  return (
    <ProductFoodSummariesProvider
      productIds={productIds}
      summaries={foodByProductId}
    >
      <Stack gap="sm">
        {view !== "table" && (
          <DataTableToolbar
            table={workbench.table}
            entity="product"
            portalWorkbenchUtilities
          />
        )}
        {view === "table" && (
          <ListWorkbench
            model={workbench}
            ariaLabel="Products Table"
            onRowClick={selectPreview}
            onRowHover={onRowHover}
            onRowHoverEnd={onRowHoverEnd}
            currentRowId={preview?.rowKey}
            desktopInspector={dockedInspector}
            inspectorToggle={inspectorToggle}
          />
        )}
        {view === "shelf" && (
          <ProductShelf
            items={items}
            isLoading={workbench.isLoading}
            error={workbench.error}
            infiniteScroll={workbench.infiniteScroll}
          />
        )}
        {view === "timeline" && (
          <ProductTimelineView filters={currentFilters} />
        )}
      </Stack>
      {view === "table" && <PreviewSheet />}
      {view !== "table" && workbench.deleteDialog}
      {discardProduct && (
        <ProductDiscardDialog
          open
          onOpenChange={(open) => {
            if (!open) setDiscardProductId(null);
          }}
          product={discardProduct}
        />
      )}
      {quickEditProduct && (
        <InventoryEntriesQuickEditDialog
          open
          onOpenChange={(open) => {
            if (!open) setQuickEditProductId(null);
          }}
          productName={quickEditProduct.name}
          entries={quickEditProduct.inventoryEntry}
        />
      )}
    </ProductFoodSummariesProvider>
  );
}
