"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/util";
import { useState } from "react";
import { ProductPillLink, RecipePillLink } from "../_components/EntityPill";
import RTable from "../_components/data-table/Table";
import { buildSelectColumn } from "../_components/data-table/row-selection";
import { IngredientMerger } from "./ingredient-merger";
import { buildunitMappingsGraph } from "../_components/units/UnitMappingGraph";
import { unitMappignsFromProduct } from "~/schemas/combo";
import { UnitMappingsTable } from "../_components/units/unitmappingstable";
import { useWasm } from "~/wasmContext";
import { Checkbox } from "~/components/ui/checkbox";
import { useTableState } from "../_components/data-table/useTableState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createCreatedAtColumn,
  createIdColumn,
} from "../_components/data-table/columnHelpers";

import { useQuery } from "@tanstack/react-query";

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
      nameFilter: tableState.getColumnFilter("name"),
      missingProductsOnly: globalFilter.missingProductsOnly,
    }),
  );

  const data = ingredientsResp?.items || [];
  type IngredientData = Flatten<typeof data>;
  const columnHelper = createColumnHelper<IngredientData>();
  const { w } = useWasm();

  // Set up columns using helpers where possible
  const columns = [
    buildSelectColumn<IngredientData>(),
    columnHelper.accessor("name", {
      enableSorting: true,
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("aliases", {
      cell: (info) => (
        <ul>
          {info.getValue().map((alias) => (
            <li key={alias}>{alias}</li>
          ))}
        </ul>
      ),
    }),
    createCreatedAtColumn(columnHelper),
    createIdColumn(columnHelper, "ingredients"),
    columnHelper.accessor("appearsInRecipes", {
      enableSorting: false,
      cell: (info) => (
        <div>
          <ul className="">
            {info
              .getValue()
              .filter(
                (obj1, i, arr) =>
                  arr.findIndex((obj2) => obj2.id === obj1.id) === i,
              )
              .map((recipe) => (
                <li key={recipe.id}>
                  <RecipePillLink recipe={recipe} />
                </li>
              ))}
          </ul>
        </div>
      ),
    }),
    columnHelper.accessor("product", {
      enableSorting: false,
      cell: (info) => (
        <div>
          <ul className="">
            {info.getValue().map((product) => (
              <li key={product.id}>
                <ProductPillLink product={product} />
              </li>
            ))}
          </ul>
        </div>
      ),
    }),
    columnHelper.accessor("product", {
      id: "product2",
      enableSorting: false,
      cell: (info) => {
        const product = info.getValue();
        const mappings = product.flatMap((product) =>
          unitMappignsFromProduct(product),
        );
        return (
          w && (
            <div>
              <UnitMappingsTable mappings={mappings} w={w} />
              {buildunitMappingsGraph(w, mappings)}
            </div>
          )
        );
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
      <IngredientMerger table={table} />
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
