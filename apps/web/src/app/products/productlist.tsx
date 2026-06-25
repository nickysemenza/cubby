import { formatCategoryLabel, getCategoryColor } from "@cubby/shared";
import type { FoodSummary } from "@cubby/usda-schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnFiltersState } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import { Package, Printer } from "lucide-react";
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { Row } from "~/components/layout";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { Skeleton } from "~/components/ui/skeleton";
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
import { EntityPillLink } from "../_components/EntityPill";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { NoneState } from "../_components/NoneState";
import { CategoryBadge } from "../_components/products/CategoryBadge";
import { productCategoryOptionsWithTheme } from "../_components/products/product-category-icons";
import { ProductShelf } from "../_components/products/product-shelf";

// Lazy "USDA Food" column plumbing. The products table renders immediately from
// `product.list` (food = null); food is fetched separately via
// `product.foodForIds` and handed to the cells through context. Context updates
// bypass the row-level `React.memo` in Table.tsx, so cells refresh when food
// lands without rebuilding columns or mutating row data.
const ProductFoodContext = createContext<{
  foodById: Record<string, FoodSummary | null>;
  isLoading: boolean;
}>({ foodById: {}, isLoading: false });

function FoodCell({
  productId,
  canHaveFood,
}: {
  productId: string;
  canHaveFood: boolean;
}) {
  const { foodById, isLoading } = useContext(ProductFoodContext);
  const food = foodById[productId];
  if (food) {
    return <EntityPillLink entity="usda-food" data={food} compact />;
  }
  // Still loading and this product *could* resolve a food (has fdc_id/upc) →
  // show a placeholder rather than a "none" dash that would later flip to a pill.
  if (isLoading && canHaveFood && !(productId in foodById)) {
    return <Skeleton className="h-5 w-16" />;
  }
  return <NoneState />;
}

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
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("product");

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
      // Lazy USDA food: rendered from context (fetched via product.foodForIds),
      // not from row data — keeps the USDA round-trip off the list query.
      columnHelper.display({
        id: "food",
        header: "USDA Food",
        enableSorting: false,
        meta: {
          className: "w-32",
          mobile: { slot: "meta", priority: 70 },
        },
        cell: ({ row }) => (
          <FoodCell
            productId={row.original.id}
            canHaveFood={
              row.original.fdc_id != null || row.original.upc != null
            }
          />
        ),
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
    getMappings: getAllUnitMappingsFromProduct,
    tableStateOptions,
    columns,
    filters,
    deletable: deletableConfig,
    extraActions,
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

  // Lazy USDA food for the visible page. Only the table view shows the column,
  // so the shelf view never triggers the USDA round-trip.
  const productIds = useMemo(() => data.map((p) => p.id), [data]);
  const foodForIdsQuery = useQuery({
    ...api.product.foodForIds.queryOptions({ ids: productIds }),
    enabled: view === "table" && productIds.length > 0,
  });
  const foodContextValue = useMemo(
    () => ({
      foodById: Object.fromEntries(
        (foodForIdsQuery.data ?? []).map((r) => [r.id, r.food]),
      ),
      isLoading: foodForIdsQuery.isLoading,
    }),
    [foodForIdsQuery.data, foodForIdsQuery.isLoading],
  );

  return (
    <ProductFoodContext.Provider value={foodContextValue}>
      <div>
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
      </div>
    </ProductFoodContext.Provider>
  );
}
