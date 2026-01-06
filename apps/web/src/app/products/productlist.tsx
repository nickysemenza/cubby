import type { ColumnFiltersState } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import type { ProductWithFoodOut } from "~/server/services/product.service";
import { useTRPC } from "~/trpc/react";
import {
  createCurrencyColumn,
  createExternalLinkColumn,
  createFilterableSelectColumn,
  createInventoryEntriesColumn,
  createSingleEntityPillColumn,
} from "../_components/data-table/columnHelpers";
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
  const columnHelper = createColumnHelper<ProductWithFoodOut>();
  const { onRowClick, PreviewSheet } = useEntityPreview("product");

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
      createSingleEntityPillColumn(columnHelper, "ingredient", "ingredient"),
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
      createCurrencyColumn(columnHelper, "price"),
      createSingleEntityPillColumn(columnHelper, "food", "usda-food", {
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
