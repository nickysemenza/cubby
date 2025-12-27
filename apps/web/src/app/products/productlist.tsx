"use client";

import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import RTable from "../_components/data-table/Table";
import {
  FoodPillLink,
  IngredientPillLink,
  LocationPillLink,
} from "../_components/EntityPill";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { NutritionInfoTable } from "../_components/usda/nutrition";
import { NoneState } from "../_components/NoneState";
import { createInventoryEntriesColumn } from "../_components/data-table/columnHelpers";
import { TableLink } from "../_components/table";
import { useEntityList } from "../_components/hooks/useEntityList";
import type { ProductWithFoodOut } from "~/server/services/product.service";
import { Badge } from "~/components/ui/badge";
import { productCategoryOptions } from "~/schemas/product";

export function ProductList() {
  const api = useTRPC();
  const columnHelper = createColumnHelper<ProductWithFoodOut>();

  const { table, filterableColumns, isLoading, error } = useEntityList({
    entity: "product",
    queryOptions: api.product.list.queryOptions,
    buildFilters: (ts) => ({
      nameFilter: ts.getColumnFilter("name"),
      manufacturerFilter: ts.getColumnFilter("manufacturer"),
      upcFilter: ts.getColumnFilter("upc"),
      categoryFilter: ts.getColumnFilter("category"),
    }),
    getMappings: getAllUnitMappingsFromProduct,
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
            <IngredientPillLink name={ingredient.name} id={ingredient.id} />
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
            <TableLink href={`/usda/upc/${upc}`} variant="mono">
              {upc}
            </TableLink>
          ) : (
            <NoneState />
          );
        },
      }),
      columnHelper.accessor("ndb_number", {
        header: "NDB",
        cell: (info) =>
          info.getValue() ? (
            <TableLink href={`/usda/ndb/${info.getValue()}`} variant="mono">
              {info.getValue()}
            </TableLink>
          ) : (
            <NoneState />
          ),
      }),
      columnHelper.accessor("model", {
        cell: (info) =>
          info.getValue() ? <code>{info.getValue()}</code> : <NoneState />,
      }),
      columnHelper.accessor("food", {
        id: "food info",
        meta: {
          mobileCategory: "compact",
          className: "w-96 max-w-96",
        },
        cell: (info) => {
          const food = info.getValue();
          if (!food) return <NoneState />;
          const { nutritionInfo } = food;
          return (
            <div className="w-48">
              <FoodPillLink food={food} />
              <NutritionInfoTable n={nutritionInfo} limit={3} />
            </div>
          );
        },
      }),
      createInventoryEntriesColumn(
        columnHelper,
        "inventoryEntry",
        LocationPillLink,
        "location",
        (e) => e.location,
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
      />
    </div>
  );
}
