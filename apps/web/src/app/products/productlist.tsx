import type { ColumnFiltersState } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { Badge } from "~/components/ui/badge";
import { productCategoryOptions } from "~/schemas/product";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import type { ProductWithFoodOut } from "~/server/services/product.service";
import { useTRPC } from "~/trpc/react";
import { createInventoryEntriesColumn } from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import {
  FoodPillLink,
  IngredientPillLink,
  LocationPillLink,
} from "../_components/EntityPill";
import { useEntityList } from "../_components/hooks/useEntityList";
import { NoneState } from "../_components/NoneState";
import { TableLink } from "../_components/table/TableLink";

interface ProductListProps {
  initialCategory?: string;
}

export function ProductList({ initialCategory }: ProductListProps) {
  const api = useTRPC();
  const columnHelper = createColumnHelper<ProductWithFoodOut>();

  // Build initial filter from URL params
  const initialFilter = useMemo((): ColumnFiltersState => {
    if (!initialCategory) return [];
    return [{ id: "category", value: initialCategory }];
  }, [initialCategory]);

  const { table, filterableColumns, isLoading, error, timing } = useEntityList({
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
        cell: (info) => {
          const category = info.getValue();
          return category ? (
            <Badge variant="secondary">{category.replace("-", " ")}</Badge>
          ) : (
            <NoneState />
          );
        },
      }),
      columnHelper.accessor("ingredient", {
        cell: (info) => {
          const ingredient = info.getValue();
          return ingredient ? (
            <IngredientPillLink ingredient={ingredient} minimal />
          ) : (
            <NoneState />
          );
        },
      }),
      columnHelper.accessor("manufacturer", {
        meta: { mobileCategory: "compact" },
        cell: (info) => info.getValue(),
      }),
      columnHelper.accessor("upc", {
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
      columnHelper.accessor("food", {
        meta: {
          mobileCategory: "compact",
        },
        cell: (info) => {
          const food = info.getValue();
          if (!food) return <NoneState />;
          return <FoodPillLink food={food} minimal />;
        },
      }),
      createInventoryEntriesColumn(
        columnHelper,
        "inventoryEntry",
        LocationPillLink,
        "location",
        (e) => e.location,
        { minimal: true },
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
          ...productCategoryOptions,
        ],
      },
    ],
  });

  return (
    <div>
      <RTable
        table={table}
        filterableColumns={filterableColumns}
        isLoading={isLoading}
        error={error}
        ariaLabel="Products Table"
        timing={timing}
      />
    </div>
  );
}
