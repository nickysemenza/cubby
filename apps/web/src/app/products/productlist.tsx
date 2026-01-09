import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnFiltersState } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { toast } from "sonner";
import { queryKeys } from "~/lib/query-keys";
import { syncPriceToMappings } from "~/schemas/price-mapping-utils";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import type { ProductWithFoodOut } from "~/server/services/product.service";
import { useTRPC } from "~/trpc/react";
import {
  createExternalLinkColumn,
  createFilterableSelectColumn,
  createInventoryEntriesColumn,
  createSingleEntityPillColumn,
} from "../_components/data-table/columnHelpers";
import { EditableCurrencyCell } from "../_components/data-table/editable-cell";
import RTable from "../_components/data-table/Table";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { NoneState } from "../_components/NoneState";
import { CategoryBadge } from "../_components/products/CategoryBadge";
import { productCategoryOptionsWithTheme } from "../_components/products/product-category-icons";

interface ProductListProps {
  initialCategory?: string;
  /** Actions to display in the table toolbar (e.g., "Create New" button) */
  actions?: ReactNode;
}

export function ProductList({ initialCategory, actions }: ProductListProps) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const columnHelper = createColumnHelper<ProductWithFoodOut>();
  const { onRowClick, PreviewSheet } = useEntityPreview("product");

  // Mutation for inline price editing
  const updateProductMutation = useMutation(
    api.product.update.mutationOptions({
      onSuccess: () => {
        toast.success("Price updated");
        void queryClient.invalidateQueries({
          queryKey: queryKeys.product.list,
        });
      },
      onError: (err) => {
        toast.error(err.message || "Failed to update price");
      },
    }),
  );

  // Build initial filter from URL params
  const initialFilter = useMemo((): ColumnFiltersState => {
    if (!initialCategory) return [];
    return [{ id: "category", value: initialCategory }];
  }, [initialCategory]);

  const { table, isLoading, error, timing } = useEntityList({
    entity: "product",
    queryOptions: api.product.list.queryOptions,
    buildFilters: (ts) => ({
      nameFilter: ts.getColumnFilter("name"),
      manufacturerFilter: ts.getColumnFilter("manufacturer"),
      upcFilter: ts.getColumnFilter("upc"),
      categoryFilter: ts.getColumnFilter("category"),
    }),
    getMappings: getAllUnitMappingsFromProduct,
    tableStateOptions: {
      initialFilter,
    },
    columns: [
      // Custom columns (image, name prepended; unitMappings, createdAt appended by hook)
      createFilterableSelectColumn(columnHelper, "category", {
        header: "Category",
        placeholder: "Filter by category...",
        selectOptions: [
          { value: "", label: "All categories" },
          ...productCategoryOptionsWithTheme,
        ],
        renderCell: (category) => <CategoryBadge category={category} />,
      }),
      createSingleEntityPillColumn(columnHelper, "ingredient", "ingredient", {
        header: "Ingredient",
      }),
      columnHelper.accessor("manufacturer", {
        meta: {
          mobileCategory: "compact",
          filterConfig: { placeholder: "Filter manufacturer..." },
        },
        cell: (info) => info.getValue(),
      }),
      createExternalLinkColumn(columnHelper, "upc", "/usda/upc/$code", {
        filterConfig: { placeholder: "Filter UPC..." },
      }),
      createExternalLinkColumn(columnHelper, "ndb_number", "/usda/ndb/$code", {
        header: "NDB",
      }),
      columnHelper.accessor("model", {
        cell: (info) =>
          info.getValue() ? (
            <code className="text-xs">{info.getValue()}</code>
          ) : (
            <NoneState />
          ),
      }),
      columnHelper.accessor("price", {
        header: "Price",
        cell: (info) => {
          const product = info.row.original;
          return (
            <EditableCurrencyCell
              value={info.getValue()}
              onSave={async (newPrice) => {
                // Sync price to unitMappings (canonical way to set price)
                const updatedMappings = syncPriceToMappings(
                  product.unitMappings,
                  newPrice !== null
                    ? { value: newPrice, unit: "dollar" }
                    : null,
                  "inline-edit",
                );
                await updateProductMutation.mutateAsync({
                  id: product.id,
                  data: { unitMappings: updatedMappings },
                });
              }}
            />
          );
        },
      }),
      createSingleEntityPillColumn(columnHelper, "food", "usda-food", {
        header: "USDA Food",
        mobileCategory: "compact",
      }),
      createInventoryEntriesColumn(
        columnHelper,
        "inventoryEntry",
        "location",
        (e) => e.location,
        {},
      ),
    ],
    filters: [
      "name",
      "manufacturer",
      "upc",
      {
        id: "category",
        placeholder: "Filter by category...",
        filterType: "select",
        options: [
          { value: "", label: "All categories" },
          ...productCategoryOptionsWithTheme,
        ],
      },
    ],
  });

  return (
    <div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Products Table"
        timing={timing}
        entity="product"
        onRowClick={onRowClick}
        actions={actions}
      />
      <PreviewSheet />
    </div>
  );
}
