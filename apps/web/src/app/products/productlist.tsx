import type { ProductListItem } from "@cubby/schemas/product";
import { formatCategoryLabel, getCategoryColor } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { uniq } from "es-toolkit";
import { Package, PackageX, Pencil, Printer } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ProductFoodSummariesProvider,
  useHydratedProductFood,
  useProductFoodSummaries,
} from "~/app/_components/products/product-food-summaries";
import { Row } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { NoneValue } from "~/components/ui/none-value";
import { OptionalStatusText, StatusText } from "~/components/ui/status-text";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { useTRPC } from "~/integrations/trpc/react";
import {
  inventoryMutationInvalidateKeys,
  productMutationInvalidateKeys,
} from "~/lib/query-keys";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { formatCurrency } from "~/lib/utils";
import { WithLocationSearch } from "../_components/combobox/with-search-hook";
import {
  createCurrencyColumn,
  createExternalLinkColumn,
  createFilterableSelectColumn,
  createInventoryEntriesColumn,
  createPlainDateColumn,
  createSingleEntityInlineLinkColumn,
  createTextColumn,
} from "../_components/data-table/columnHelpers";
import { EditableCell } from "../_components/data-table/editable-cell";
import {
  ShelfTableToggle,
  type ShelfView,
} from "../_components/data-table/shelf";
import RTable from "../_components/data-table/Table";
import type { GroupConfig } from "../_components/data-table/useGroupedList";
import { EntityInlineLink } from "../_components/EntityInlineLink";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useProductTagOptions } from "../_components/hooks/useProductTagOptions";
import { useProjectOptions } from "../_components/hooks/useProjectOptions";
import { useSeededFilter } from "../_components/hooks/useSeededFilter";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { useCreateInventoryMutation } from "../_components/inventory/hooks";
import { InventoryEntriesQuickEditDialog } from "../_components/inventory/inventory-entries-quick-edit-dialog";
import { CategoryLabel } from "../_components/products/CategoryLabel";
import { productCategoryOptionsWithTheme } from "../_components/products/product-category-icons";
import { ProductDiscardDialog } from "../_components/products/product-discard-dialog";
import { ProductShelf } from "../_components/products/product-shelf";
import { TruncatedList } from "../_components/TruncatedList";

interface ProductListProps {
  initialCategory?: string;
  actions?: ReactNode;
}

// A module-level fallback keeps the runtime options reference stable while the
// roster query is loading (and avoids turning every table render into a new
// filter configuration).
const NO_VENDOR_OPTIONS: FilterableComboboxItem[] = [];
const NO_FILTER_OPTIONS: FilterableComboboxItem[] = [];

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
    <EntityInlineLink entity="usda-food" data={food} compact />
  ) : (
    <NoneValue />
  );
}

export function ProductList({ initialCategory, actions }: ProductListProps) {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<ProductListItem>(), []);
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("product");
  // Runtime picklist for the manifest's `tags` spec (optionsKey: "tags").
  const { options: tagOptions } = useProductTagOptions();
  const { options: projectOptions } = useProjectOptions();
  // `location.options`, not `.list` or `.search`: this is a 500-row picklist
  // that renders name + breadcrumb only. `.list` would drag every row's
  // inventory entries, product embeds, and a pricing pass along with it, and
  // `.search` would add a cover-image load plus ~400 bytes of ImageOut per row
  // for thumbnails this surface never draws.
  const locationOptionsQuery = useQuery(
    api.location.options.queryOptions({
      filters: { inventoryPresenceFilter: "has" },
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 500 },
    }),
  );
  const ingredientOptionsQuery = useQuery(
    api.ingredient.list.queryOptions({
      filters: { productPresenceFilter: "has" },
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 500 },
    }),
  );
  const manufacturerOptionsQuery = useQuery(
    api.product.manufacturerOptions.queryOptions(),
  );
  const externalIdSourceOptionsQuery = useQuery(
    api.product.externalIdSourceOptions.queryOptions(),
  );
  const locationOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      locationOptionsQuery.data?.items.map(({ id, name, ancestors }) => ({
        value: id,
        label: name,
        detail: ancestors.map((a) => a.name).join(" › ") || undefined,
      })) ?? NO_FILTER_OPTIONS,
    [locationOptionsQuery.data],
  );
  const ingredientOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      ingredientOptionsQuery.data?.items.map(({ id, name }) => ({
        value: id,
        label: name,
      })) ?? NO_FILTER_OPTIONS,
    [ingredientOptionsQuery.data],
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
    api.relatedData.options.queryOptions({
      relationKey: "product.vendors",
      limit: 100,
    }),
  );
  const purchaseOptionsQuery = useQuery(
    api.relatedData.options.queryOptions({
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
    mutationFn: api.product.update.mutationOptions,
    entity: "product",
    invalidateKeys: productMutationInvalidateKeys,
  });

  const updateInventoryMutation = useUpdateMutation({
    mutationFn: api.inventory.update.mutationOptions,
    entity: "inventory",
    invalidateKeys: inventoryMutationInvalidateKeys,
  });
  const createInventoryMutation = useCreateInventoryMutation();

  const nameEditable = useNameEditable<ProductListItem>(
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

  // Use stable deletable config hook to prevent infinite render loop
  const deletableConfig = useDeletableConfig({
    mutationFn: api.product.delete.mutationOptions,
    entityLabel: "Product",
    invalidateKeys: productMutationInvalidateKeys,
    entity: "product",
  });

  const getProductListMappings = useCallback(
    (product: ProductListItem) =>
      getAllUnitMappingsFromProduct({
        ...product,
        food: foodByProductId[product.id] ?? null,
      }),
    [foodByProductId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: mutations change every render but are functionally stable
  const columns = useMemo(
    () => [
      // Custom columns (image/name prepended; related + audit dates appended by hook)
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
          onSave: async (newCategory, product) => {
            await updateProductMutation.mutateAsync({
              id: product.id,
              data: { category: newCategory },
            });
          },
        },
      }),
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
      createExternalLinkColumn(columnHelper, "upc", "/usda/upc/$code", {
        header: "UPC",
        className: "w-32",
        mobile: { interactive: true },
        editable: {
          onSave: async (newValue, product) => {
            await updateProductMutation.mutateAsync({
              id: product.id,
              data: { upc: newValue },
            });
          },
        },
      }),
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
      columnHelper.accessor((row) => row.model, {
        id: "modelPresence",
        header: "Model present",
        enableSorting: false,
        meta: { className: "w-24" },
        cell: (info) => (info.getValue() ? "Has model" : <NoneValue />),
      }),
      columnHelper.accessor((row) => row.upc, {
        id: "upcPresence",
        header: "UPC present",
        enableSorting: false,
        meta: { className: "w-24" },
        cell: (info) => (info.getValue() ? "Has UPC" : <NoneValue />),
      }),
      columnHelper.accessor((row) => row.notes, {
        id: "notesPresence",
        header: "Notes present",
        enableSorting: false,
        meta: { className: "w-24" },
        cell: (info) => (info.getValue() ? "Has notes" : <NoneValue />),
      }),
      columnHelper.accessor((row) => row.dataQuality.status, {
        id: "dataQuality",
        header: "Data quality",
        enableSorting: false,
        meta: { className: "w-28", mobile: { slot: "meta", priority: 75 } },
        cell: (info) => {
          const status = info.getValue();
          return (
            <Badge variant={status === "defect" ? "destructive" : "outline"}>
              {status === "needs_data"
                ? "Needs data"
                : status === "defect"
                  ? "Defect"
                  : "Complete"}
            </Badge>
          );
        },
      }),
      columnHelper.accessor((row) => row.dataQuality.gaps, {
        id: "dataGaps",
        header: "Data gaps",
        enableSorting: false,
        meta: { className: "w-36", mobile: { slot: "meta", priority: 80 } },
        cell: (info) => {
          const gaps = info.getValue();
          if (!gaps.length) return <NoneValue />;
          return (
            <span className="text-muted-foreground text-xs">
              {gaps.map((gap) => gap.check.replaceAll("_", " ")).join(", ")}
            </span>
          );
        },
      }),
      columnHelper.accessor("externalIds", {
        id: "externalIds",
        header: "External IDs",
        enableSorting: false,
        meta: { className: "w-36", mobile: { slot: "meta", priority: 85 } },
        cell: (info) => {
          const ids = info.getValue();
          if (!ids.length) return <NoneValue />;
          return (
            <span className="text-muted-foreground text-xs">
              {ids.map((externalId) => externalId.source).join(", ")}
            </span>
          );
        },
      }),
      columnHelper.accessor((product) => product.pricing.effectivePrice, {
        id: "price",
        header: "Price",
        meta: {
          numeric: true,
          className: "w-20",
          mobile: { slot: "trailing", priority: 10, interactive: true },
        },
        footer: (info) => {
          const total = info.table.options.meta?.serverTotals?.sums?.price;
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
              config={{ type: "currency" }}
              renderValue={() =>
                product.pricing.effectivePrice === null ? (
                  <NoneValue />
                ) : (
                  <span className="text-positive">
                    {formatCurrency(product.pricing.effectivePrice)}
                  </span>
                )
              }
            />
          );
        },
      }),
      // Net cost basis — SUM(cost) over this product's live expenses, so an
      // exit (a sale booked as a negative row) telescopes against its
      // acquisition. Hidden by default via `initialColumnVisibility`: the table
      // is already wide and `price` covers the common case, but it's a real
      // column so the number is visible rather than only sortable.
      //
      // `zeroAsEmpty: false` is load-bearing, not a style choice. The helper
      // defaults it true because "a zero price means unset" — but
      // `productListItemOut.expenseTotal` is 0 for a product with no expenses
      // and never null, so the default would dash every expense-less product as
      // though the value were missing. Same opt-out as `expenseTotal` on the
      // purchase list and `spend` on the vendor list.
      createCurrencyColumn(columnHelper, "expenseTotal", {
        header: "Net basis",
        className: "w-28",
        zeroAsEmpty: false,
        signedTone: true,
        mobile: { slot: "trailing", priority: 5 },
      }),
      // Units bought minus units gone. Hidden by default — the table is
      // already wide — but a real column, so the number can be sorted and
      // filtered rather than only inferred from the expense history.
      //
      // The `+N?` / `-N?` suffix is the honesty half of the cell and is not
      // decoration: an expense line with no recorded quantity contributes
      // nothing to the number, so without the cue a product with six
      // unquantified receipts reads as a confident 0. Same shape as
      // `knownAcquiredUnits` in relationship-summary-table.
      columnHelper.accessor((row) => row.quantityLedger.expectedQuantity, {
        id: "expectedQuantity",
        header: "Expected",
        meta: {
          numeric: true,
          className: "w-24",
          mobile: { slot: "meta", priority: 45 },
        },
        cell: (info) => (
          <ExpectedQuantityCell ledger={info.row.original.quantityLedger} />
        ),
      }),
      // Shelf minus ledger. Dashes when the product isn't stocked, and when its
      // entries carry more than one unit (see `deriveOnHandUnits`).
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
      createPlainDateColumn(columnHelper, "purchaseDate", {
        header: "Purchase date",
        className: "w-32",
        mobile: { slot: "meta", priority: 55 },
      }),
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
            SearchProvider: WithLocationSearch,
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
      // Read-only: the Tags filter spec declares `columnId: "tags"`, and the
      // header-filter machinery needs a real column to hang that control on —
      // without it the table logs `Column with id 'tags' does not exist` and
      // the filter is only reachable by hand-editing the URL. Editing stays in
      // the product form / detail page rather than an inline array editor.
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
      columnHelper.accessor("expenseCount", {
        id: "expenses",
        header: "Expenses",
        // The column id is `expenses`, which is NOT in `productSortableFields`
        // — so `buildOrderBy` silently discards any sort on it. Without this the
        // header renders a clickable sort affordance that does nothing. The id
        // can't be renamed to `expenseCount` to fix it the other way: it's
        // persisted per-user in the `table-columns:product` localStorage key,
        // and renaming would reset everyone's column layout for a count.
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
    ],
    [columnHelper],
  );

  // Memoize filters to prevent recreating on every render
  const extraActions = useCallback(
    (row: ProductListItem) => (
      <>
        <DropdownMenuItem onClick={() => setQuickEditProductId(row.id)}>
          <Pencil className="mr-2 size-4" />
          Edit locations
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setDiscardProductId(row.id)}>
          <PackageX className="mr-2 size-4" />
          Discard
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link to="/inventory/session" />}>
          <Package className="mr-2 size-4" />
          Add to Inventory
        </DropdownMenuItem>
        {row.id && (
          <DropdownMenuItem
            render={<Link to="/labels" search={{ codes: row.id }} />}
          >
            <Printer className="mr-2 size-4" />
            Print Label
          </DropdownMenuItem>
        )}
      </>
    ),
    [],
  );

  const groupKeyFn = useCallback(
    (item: ProductListItem) => formatCategoryLabel(item.category),
    [],
  );
  const groupColorFn = useCallback(
    (key: string) =>
      getCategoryColor(
        key === "uncategorized"
          ? null
          : (key.replace(" ", "-") as Parameters<typeof getCategoryColor>[0]),
      ),
    [],
  );
  const groupConfig = useMemo(
    (): GroupConfig<ProductListItem> => ({
      field: "category",
      keyFn: groupKeyFn,
      colorFn: groupColorFn,
    }),
    [groupKeyFn, groupColorFn],
  );

  const queryOptions = api.product.list.queryOptions;

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
    grouped,
    onGroupedChange,
    totalCount,
  } = useEntityList({
    entity: "product",
    queryOptions,
    getMappings: getProductListMappings,
    tableStateOptions,
    columns,
    deletable: deletableConfig,
    filterOptions,
    extraActions,
    nameEditable,
    initialColumnVisibility: {
      tags: false,
      fdc_id: false,
      model: false,
      manufacturer: false,
      createdAt: false,
      notes: false,
      expenseTotal: false,
      expectedQuantity: false,
      quantityVariance: false,
      dataQuality: false,
      dataGaps: false,
      externalIds: false,
      modelPresence: false,
      upcPresence: false,
      notesPresence: false,
    },
    groupConfig,
  });
  usePageCount(totalCount);

  const [view, setView] = useState<ShelfView>("table");
  const items = table.getRowModel().rows.map((r) => r.original);
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
      <Row align="center" justify="between" gap="sm" className="mb-4">
        {/* Keep primary actions reachable in shelf view (they live in the
            table toolbar otherwise). */}
        <div className="min-w-0">{view === "shelf" ? actions : null}</div>
        <ShelfTableToggle value={view} onChange={setView} />
      </Row>
      {view === "shelf" ? (
        <ProductShelf
          items={items}
          isLoading={isLoading}
          error={error}
          infiniteScroll={infiniteScroll}
        />
      ) : (
        <RTable
          table={table}
          isLoading={isLoading}
          error={error}
          ariaLabel="Products Table"
          timing={timing}
          entity="product"
          onRowClick={onRowClick}
          onRowHover={onRowHover}
          actions={actions}
          bulkActionBar={bulkActionBar}
          infiniteScroll={infiniteScroll}
          refreshControls={refreshControls}
          groupConfig={groupConfig}
          grouped={grouped}
          onGroupedChange={onGroupedChange}
        />
      )}
      <PreviewSheet />
      {deleteDialog}
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
