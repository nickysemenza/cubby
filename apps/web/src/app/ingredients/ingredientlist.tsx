"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { useState } from "react";
import { useAsyncMemo } from "~/hooks/useAsyncMemo";
import { ProductPillLink, RecipePillLink } from "../_components/EntityPill";
import RTable from "../_components/data-table/Table";
import { buildSelectColumn } from "../_components/data-table/row-selection";
import { IngredientMerger } from "./ingredient-merger";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { Checkbox } from "~/components/ui/checkbox";
import { Button } from "~/components/ui/button";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createCreatedAtColumn,
  createImageColumn,
  createNameColumn,
  createEntityPillColumn,
  createUnitMappingsColumn,
} from "../_components/data-table/columnHelpers";
import Link from "next/link";
import { entities } from "~/entities/entities";
import { useTableList } from "../_components/hooks/useTableList";
import { type IngredientWithFoodOut } from "~/server/services/ingredient.service";

export function IngredientList() {
  const api = useTRPC();

  // Set up global filter for missing products
  const [globalFilter, setGlobalFilter] = useState({
    missingProductsOnly: false,
  });

  const { data, totalCount, isLoading, error, tableState } = useTableList<
    {
      nameFilter: string | undefined;
      missingProductsOnly: boolean;
    },
    IngredientWithFoodOut
  >({
    queryOptions: api.ingredient.list.queryOptions,
    buildFilters: (tableState) => ({
      nameFilter: tableState.getColumnFilter("name"),
      missingProductsOnly: globalFilter.missingProductsOnly,
    }),
    tableStateOptions: { initialSort: "createdAt" },
  });

  // Pre-load unit mappings for all ingredients asynchronously (parallelized)
  const mappingsMap = useAsyncMemo(
    async (signal) => {
      const entries = await Promise.all(
        data.map(async (ingredient) => {
          const productMappings = await Promise.all(
            ingredient.product.map((p) => getAllUnitMappingsFromProduct(p)),
          );
          return [ingredient.id, productMappings.flat()] as const;
        }),
      );
      if (signal.cancelled) return {};
      return Object.fromEntries(entries);
    },
    [data],
    {},
  );

  const columnHelper = createColumnHelper<IngredientWithFoodOut>();
  // Set up columns using helpers where possible
  const columns = [
    buildSelectColumn<IngredientWithFoodOut>(),
    createImageColumn(columnHelper),
    createNameColumn(columnHelper, "ingredient"),
    columnHelper.accessor("aliases", {
      cell: (info) => (
        <div className="space-y-0.5 text-xs">
          {info.getValue().map((alias: string) => (
            <div key={alias} className="truncate">
              {alias}
            </div>
          ))}
        </div>
      ),
    }),
    createCreatedAtColumn(columnHelper),
    createEntityPillColumn(
      columnHelper,
      "appearsInRecipes",
      RecipePillLink,
      "recipe",
      { className: "w-48 max-w-48", dedupe: true },
    ),
    createEntityPillColumn(
      columnHelper,
      "product",
      ProductPillLink,
      "product",
      {
        className: "w-48 max-w-48",
      },
    ),
    createUnitMappingsColumn(columnHelper, mappingsMap, {
      id: "product2",
      className: "w-72 max-w-72",
    }),
  ];

  // Configure the table with global filter
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount,
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
          <Link href={`/${entities.ingredient.basePath}/new`}>
            Create New Ingredient
          </Link>
        </Button>
      </div>
      <RTable
        table={table}
        filterableColumns={filterableColumns}
        isLoading={isLoading}
        error={error}
        ariaLabel="Ingredients Table"
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
