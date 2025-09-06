"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/array-helpers";
import { useState } from "react";
import { ProductPillLink, RecipePillLink } from "../_components/EntityPill";
import RTable from "../_components/data-table/Table";
import { buildSelectColumn } from "../_components/data-table/row-selection";
import { IngredientMerger } from "./ingredient-merger";
import { unitMappingsFromProduct } from "~/schemas/combo";
import { UnitMappingDisplay } from "../_components/units/UnitMappingDisplay";
import { Checkbox } from "~/components/ui/checkbox";
import { Button } from "~/components/ui/button";
import { useTableState } from "../_components/data-table/useTableState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createCreatedAtColumn,
  createImageColumn,
  createNameColumn,
} from "../_components/data-table/columnHelpers";
import Link from "next/link";

import { useQuery } from "@tanstack/react-query";
import { EntityPillLinkList } from "../_components/EntityPillLinkList";

export function IngredientList() {
  const api = useTRPC();
  // Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });

  // Set up global filter for missing products
  const [globalFilter, setGlobalFilter] = useState({
    missingProductsOnly: false,
  });

  // Query data with params from table state
  const { data: ingredientsResp, isLoading } = useQuery(
    api.ingredient.list.queryOptions({
      sort: tableState.getSortParams(),
      pagination: tableState.pagination,
      filters: {
        nameFilter: tableState.getColumnFilter("name"),
        missingProductsOnly: globalFilter.missingProductsOnly,
      },
    }),
  );

  const data = ingredientsResp?.items || [];
  type IngredientData = Flatten<typeof data>;
  const columnHelper = createColumnHelper<IngredientData>();
  // Set up columns using helpers where possible
  const columns = [
    buildSelectColumn<IngredientData>(),
    createImageColumn(columnHelper),
    createNameColumn(columnHelper, "ingredient"),
    columnHelper.accessor("aliases", {
      cell: (info) => (
        <div className="space-y-0.5 text-xs">
          {info.getValue().map((alias) => (
            <div key={alias} className="truncate">
              {alias}
            </div>
          ))}
        </div>
      ),
    }),
    createCreatedAtColumn(columnHelper),
    columnHelper.accessor("appearsInRecipes", {
      enableSorting: false,
      meta: { className: "w-48 max-w-48" },
      cell: (info) => (
        <EntityPillLinkList
          items={info
            .getValue()
            .filter(
              (obj1, i, arr) =>
                arr.findIndex((obj2) => obj2.id === obj1.id) === i,
            )}
          Pill={RecipePillLink}
          pillPropName="recipe"
        />
      ),
    }),
    columnHelper.accessor("product", {
      enableSorting: false,
      meta: { className: "w-48 max-w-48" },
      cell: (info) => (
        <EntityPillLinkList
          items={info.getValue()}
          Pill={ProductPillLink}
          pillPropName="product"
        />
      ),
    }),
    columnHelper.accessor("product", {
      id: "product2",
      enableSorting: false,
      meta: { className: "w-72 max-w-72" },
      cell: (info) => {
        const product = info.getValue();
        const mappings = product.flatMap((product) =>
          unitMappingsFromProduct(product),
        );
        return <UnitMappingDisplay mappings={mappings} title="" />;
      },
    }),
  ];

  // Configure the table with global filter
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount: ingredientsResp?.meta?.totalCount || 0,
    globalFilter,
    onGlobalFilterChange: setGlobalFilter,
  });

  const filterableColumns = [
    {
      id: "name",
      placeholder: "Filter by ingredient name...",
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <IngredientMerger table={table} />
        <Button asChild variant="default">
          <Link href="/ingredients/new">Create New Ingredient</Link>
        </Button>
      </div>
      <RTable
        table={table}
        filterableColumns={filterableColumns}
        isLoading={isLoading}
        additionalFilters={
          <div className="flex items-center space-x-2">
            <Checkbox
              id="missingProductsOnly"
              checked={table.getState().globalFilter.missingProductsOnly}
              onCheckedChange={(checked) =>
                table.setGlobalFilter({ missingProductsOnly: checked })
              }
            />
            <label
              htmlFor="missingProductsOnly"
              className="text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Missing Products Only
            </label>
          </div>
        }
      />
    </div>
  );
}
