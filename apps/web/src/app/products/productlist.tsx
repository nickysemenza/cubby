import type { ProductListItem } from "@cubby/schemas/product";
import { formatCategoryLabel, getCategoryColor } from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { uniq } from "es-toolkit";
import { Package, Pencil, Printer } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ProductFoodSummariesProvider,
  useHydratedProductFood,
  useProductFoodSummaries,
} from "~/app/_components/products/product-food-summaries";
import { Row } from "~/components/layout";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { NoneValue } from "~/components/ui/none-value";
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
import { WithLocationSearch } from "../_components/combobox/with-search-hook";
import {
  createCurrencyColumn,
  createExternalLinkColumn,
  createFilterableSelectColumn,
  createInventoryEntriesColumn,
  createSingleEntityInlineLinkColumn,
  createTextColumn,
  presenceFilterOptions,
} from "../_components/data-table/columnHelpers";
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
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useSeededFilter } from "../_components/hooks/useSeededFilter";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { useCreateInventoryMutation } from "../_components/inventory/hooks";
import { InventoryEntriesQuickEditDialog } from "../_components/inventory/inventory-entries-quick-edit-dialog";
import { CategoryLabel } from "../_components/products/CategoryLabel";
import { productCategoryOptionsWithTheme } from "../_components/products/product-category-icons";
import { ProductShelf } from "../_components/products/product-shelf";

interface ProductListProps {
  initialCategory?: string;
  /** Actions to display in the table toolbar (e.g., "Create New" button) */
  actions?: ReactNode;
}

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
  const [foodHydrationIds, setFoodHydrationIds] = useState<readonly string[]>(
    [],
  );
  const foodByProductId = useProductFoodSummaries(foodHydrationIds);

  // Mutation for inline editing (price, category, etc.)
  const updateProductMutation = useUpdateMutation({
    mutationFn: api.product.update.mutationOptions,
    entity: "product",
    invalidateKeys: productMutationInvalidateKeys,
  });

  // Inline edit + create for the Locations column (move an entry's location,
  // or create a new inventory entry from an empty cell).
  const updateInventoryMutation = useUpdateMutation({
    mutationFn: api.inventory.update.mutationOptions,
    entity: "inventory",
    invalidateKeys: inventoryMutationInvalidateKeys,
  });
  const createInventoryMutation = useCreateInventoryMutation();

  // Inline name editing on the hook-prepended name column.
  const nameEditable = useNameEditable<ProductListItem>(
    updateProductMutation.mutateAsync,
  );

  // Quick-edit dialog for a row's inventory entries; track the id and derive
  // the product from live list data so post-save invalidation refreshes the
  // open dialog too.
  const [quickEditProductId, setQuickEditProductId] = useState<string | null>(
    null,
  );

  const tableStateOptions = useSeededFilter("category", initialCategory);

  // Use stable deletable config hook to prevent infinite render loop
  const deletableConfig = useDeletableConfig({
    mutationFn: api.product.delete.mutationOptions,
    entityLabel: "Product",
    invalidateKeys: productMutationInvalidateKeys,
  });

  const getProductListMappings = useCallback(
    (product: ProductListItem) =>
      getAllUnitMappingsFromProduct({
        ...product,
        food: foodByProductId[product.id] ?? null,
      }),
    [foodByProductId],
  );

  // Memoize columns to prevent recreating on every render
  // Note: updateProductMutation/updateInventoryMutation/createInventoryMutation
  // are NOT in dependencies because useMutation returns a new object every render.
  // The closures capture them correctly, and we only need to recreate if columnHelper changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mutations change every render but are functionally stable
  const columns = useMemo(
    () => [
      // Custom columns (image, name prepended; unitMappings, createdAt appended by hook)
      createFilterableSelectColumn(columnHelper, "category", {
        header: "Category",
        className: "w-32",
        placeholder: "Filter by category...",
        selectOptions: [
          { value: "", label: "All categories" },
          ...productCategoryOptionsWithTheme,
        ],
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
          filterConfig: {
            placeholder: "Filter ingredient...",
            filterType: "select",
            options: presenceFilterOptions("ingredient"),
          },
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
        className: "min-w-0 w-40 truncate",
        mobile: { slot: "subtitle", priority: 20 },
        filterConfig: { placeholder: "Filter manufacturer..." },
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
        filterConfig: { placeholder: "Filter UPC..." },
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
      createCurrencyColumn(columnHelper, "price", {
        header: "Price",
        mobile: { slot: "trailing", priority: 10, interactive: true },
        editable: {
          onSave: async (newPrice, product) => {
            await updateProductMutation.mutateAsync({
              id: product.id,
              data: { price: newPrice },
            });
          },
        },
      }),
      columnHelper.display({
        id: "food",
        header: "USDA Food",
        meta: {
          className: "w-32",
          mobile: { slot: "meta", priority: 70 },
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
          filterConfig: {
            placeholder: "Filter locations...",
            filterType: "select",
            options: presenceFilterOptions("inventory"),
          },
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
    ],
    [columnHelper],
  );

  // Memoize filters to prevent recreating on every render
  const filters = useMemo(
    () => [
      "name",
      "manufacturer",
      "upc",
      {
        id: "category",
        placeholder: "Filter by category...",
        filterType: "select" as const,
        options: [
          { value: "", label: "All categories" },
          ...productCategoryOptionsWithTheme,
        ],
      },
    ],
    [],
  );

  // Memoize buildFilters to prevent recreating on every render
  const buildFilters = useCallback(
    (ts: { getColumnFilter: (id: string) => unknown }) => ({
      nameFilter: ts.getColumnFilter("name"),
      manufacturerFilter: ts.getColumnFilter("manufacturer"),
      upcFilter: ts.getColumnFilter("upc"),
      categoryFilter: ts.getColumnFilter("category"),
      inventoryPresenceFilter: ts.getColumnFilter("location"),
      ingredientPresenceFilter: ts.getColumnFilter("ingredient"),
    }),
    [],
  );

  const extraActions = useCallback(
    (row: ProductListItem) => (
      <>
        <DropdownMenuItem onClick={() => setQuickEditProductId(row.id)}>
          <Pencil className="mr-2 h-4 w-4" />
          Edit locations
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link to="/inventory/session" />}>
          <Package className="mr-2 h-4 w-4" />
          Add to Inventory
        </DropdownMenuItem>
        {row.shortcode && (
          <DropdownMenuItem
            render={<Link to="/labels" search={{ codes: row.shortcode }} />}
          >
            <Printer className="mr-2 h-4 w-4" />
            Print Label
          </DropdownMenuItem>
        )}
      </>
    ),
    [],
  );

  // Group by product category for mobile section headers
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

  // Capture queryOptions ONCE - tRPC Proxy might return new reference on each access!
  // Store the actual function, not a getter
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
  } = useEntityList({
    entity: "product",
    queryOptions,
    buildFilters,
    getMappings: getProductListMappings,
    tableStateOptions,
    columns,
    filters,
    deletable: deletableConfig,
    extraActions,
    nameEditable,
    infinite: true,
    initialColumnVisibility: {
      fdc_id: false,
      model: false,
      manufacturer: false,
      createdAt: false,
      notes: false,
    },
    groupConfig,
  });

  const [view, setView] = useState<ShelfView>("table");
  const items = table.getRowModel().rows.map((r) => r.original);
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
