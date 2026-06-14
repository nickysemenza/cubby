import { formatCategoryLabel, getCategoryColor } from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import type { ColumnFiltersState } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import { Package, Printer } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { queryKeys } from "~/lib/query-keys";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import type { ProductWithFoodOut } from "~/server/services/product.service";
import { useTRPC } from "~/trpc/react";
import {
  createCurrencyColumn,
  createExternalLinkColumn,
  createFilterableSelectColumn,
  createInventoryEntriesColumn,
  createSingleEntityPillColumn,
  createTextColumn,
} from "../_components/data-table/columnHelpers";
import {
  ShelfTableToggle,
  type ShelfView,
} from "../_components/data-table/shelf";
import RTable from "../_components/data-table/Table";
import type { GroupConfig } from "../_components/data-table/useGroupedList";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { CategoryBadge } from "../_components/products/CategoryBadge";
import { productCategoryOptionsWithTheme } from "../_components/products/product-category-icons";
import { ProductShelf } from "../_components/products/product-shelf";

interface ProductListProps {
  initialCategory?: string;
  /** Actions to display in the table toolbar (e.g., "Create New" button) */
  actions?: ReactNode;
}

export function ProductList({ initialCategory, actions }: ProductListProps) {
  const api = useTRPC();
  const columnHelper = useMemo(
    () => createColumnHelper<ProductWithFoodOut>(),
    [],
  );
  const { onRowClick, PreviewSheet } = useEntityPreview("product");

  // Memoize invalidate keys to prevent recreating on every render
  const invalidateKeys = useMemo(() => [queryKeys.product.list] as const, []);

  // Mutation for inline editing (price, category, etc.)
  const updateProductMutation = useUpdateMutation({
    mutationFn: api.product.update.mutationOptions,
    entity: "product",
    invalidateKeys,
  });

  // Build initial filter from URL params
  const initialFilter = useMemo((): ColumnFiltersState => {
    if (!initialCategory) return [];
    return [{ id: "category", value: initialCategory }];
  }, [initialCategory]);

  // Memoize table state options to prevent recreating on every render
  const tableStateOptions = useMemo(
    () => ({
      initialFilter,
    }),
    [initialFilter],
  );

  // Use stable deletable config hook to prevent infinite render loop
  const deletableConfig = useDeletableConfig({
    mutationFn: api.product.delete.mutationOptions,
    entityLabel: "Product",
    invalidateKeys: [[queryKeys.product.list]],
  });

  // Memoize columns to prevent recreating on every render
  // Note: updateProductMutation is NOT in dependencies because useMutation returns a new object every render
  // The closure captures it correctly, and we only need to recreate if columnHelper changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: updateProductMutation changes every render but is functionally stable
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
        renderCell: (cat) => <CategoryBadge category={cat} />,
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
      createSingleEntityPillColumn(columnHelper, "ingredient", "ingredient", {
        header: "Ingredient",
        className: "w-32",
        mobile: { slot: "meta", priority: 45 },
        enableSorting: true,
      }),
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
        className: "w-32",
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
      createExternalLinkColumn(columnHelper, "ndb_number", "/usda/ndb/$code", {
        header: "NDB",
        className: "w-32",
        editable: {
          onSave: async (newValue, product) => {
            await updateProductMutation.mutateAsync({
              id: product.id,
              data: { ndb_number: newValue ? Number(newValue) : null },
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
      columnHelper.accessor("notes", {
        header: "Notes",
        meta: { className: "min-w-0 w-40" },
        cell: ({ row }) => {
          const notes = row.original.notes;
          if (!notes) return null;
          return (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="block truncate text-muted-foreground" />
                }
              >
                {notes}
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                {notes}
              </TooltipContent>
            </Tooltip>
          );
        },
      }),
      createCurrencyColumn(columnHelper, "price", {
        header: "Price",
        mobile: { slot: "trailing", priority: 10 },
        editable: {
          onSave: async (newPrice, product) => {
            await updateProductMutation.mutateAsync({
              id: product.id,
              data: { price: newPrice },
            });
          },
        },
      }),
      createSingleEntityPillColumn(columnHelper, "food", "usda-food", {
        header: "USDA Food",
        className: "w-32",
        mobile: { slot: "meta", priority: 70 },
      }),
      createInventoryEntriesColumn(
        columnHelper,
        "inventoryEntry",
        "location",
        (e) => e.location,
        {},
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
    }),
    [],
  );

  const extraActions = useCallback(
    (row: ProductWithFoodOut) => (
      <>
        <DropdownMenuItem
          render={
            <Link
              to="/inventory/quick-capture"
              search={{ productId: row.id }}
            />
          }
        >
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
    (item: ProductWithFoodOut) => formatCategoryLabel(item.category),
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
    (): GroupConfig<ProductWithFoodOut> => ({
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
    getMappings: getAllUnitMappingsFromProduct,
    tableStateOptions,
    columns,
    filters,
    deletable: deletableConfig,
    extraActions,
    infinite: true,
    initialColumnVisibility: {
      ndb_number: false,
      model: false,
      manufacturer: false,
      createdAt: false,
      notes: false,
    },
    groupConfig,
  });

  const [view, setView] = useState<ShelfView>("table");
  const items = table.getRowModel().rows.map((r) => r.original);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        {/* Keep primary actions reachable in shelf view (they live in the
            table toolbar otherwise). */}
        <div className="min-w-0">{view === "shelf" ? actions : null}</div>
        <ShelfTableToggle value={view} onChange={setView} />
      </div>
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
    </div>
  );
}
