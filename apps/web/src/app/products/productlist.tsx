import type { ColumnFiltersState } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import type { ProductWithFoodOut } from "~/server/services/product.service";
import { useTRPC } from "~/trpc/react";
import { createInventoryEntriesColumn } from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { EntityPillLink } from "../_components/EntityPill";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { NoneState } from "../_components/NoneState";
import { CategoryBadge } from "../_components/products/CategoryBadge";
import { productCategoryOptionsWithTheme } from "../_components/products/product-category-icons";
import { TableLink } from "../_components/table/TableLink";

interface ProductListProps {
  initialCategory?: string;
}

export function ProductList({ initialCategory }: ProductListProps) {
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
      columnHelper.accessor("category", {
        header: "Category",
        meta: {
          filterConfig: {
            placeholder: "Filter by category...",
            filterType: "select",
            options: [
              { value: "", label: "All categories" },
              ...productCategoryOptionsWithTheme,
            ],
          },
        },
        cell: (info) => <CategoryBadge category={info.getValue()} />,
      }),
      columnHelper.accessor("ingredient", {
        cell: (info) => {
          const ingredient = info.getValue();
          return ingredient ? (
            <EntityPillLink entity="ingredient" data={ingredient} compact />
          ) : (
            <NoneState />
          );
        },
      }),
      columnHelper.accessor("manufacturer", {
        meta: {
          mobileCategory: "compact",
          filterConfig: { placeholder: "Filter manufacturer..." },
        },
        cell: (info) => info.getValue(),
      }),
      columnHelper.accessor("upc", {
        meta: {
          filterConfig: { placeholder: "Filter UPC..." },
        },
        cell: (info) => {
          const upc = info.getValue();
          return upc ? (
            <TableLink
              to="/usda/upc/$code"
              params={{ code: upc }}
              variant="mono"
            >
              {upc}
            </TableLink>
          ) : (
            <NoneState />
          );
        },
      }),
      columnHelper.accessor("ndb_number", {
        header: "NDB",
        cell: (info) => {
          const ndb = info.getValue();
          return ndb ? (
            <TableLink
              to="/usda/ndb/$code"
              params={{ code: String(ndb) }}
              variant="mono"
            >
              {ndb}
            </TableLink>
          ) : (
            <NoneState />
          );
        },
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
          const price = info.getValue();
          if (price === null || price === undefined) return <NoneState />;
          return formatCurrency(price);
        },
      }),
      columnHelper.accessor("food", {
        meta: {
          mobileCategory: "compact",
        },
        cell: (info) => {
          const food = info.getValue();
          if (!food) return <NoneState />;
          return <EntityPillLink entity="usda-food" data={food} compact />;
        },
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
      />
      <PreviewSheet />
    </div>
  );
}
