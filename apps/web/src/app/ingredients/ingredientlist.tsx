"use client";

import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { useState } from "react";
import { ProductPillLink, RecipePillLink } from "../_components/EntityPill";
import RTable from "../_components/data-table/Table";
import { buildSelectColumn } from "../_components/data-table/row-selection";
import { IngredientMerger } from "./ingredient-merger";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { Checkbox } from "~/components/ui/checkbox";
import { Button } from "~/components/ui/button";
import {
  createCreatedAtColumn,
  createImageColumn,
  createNameColumn,
  createEntityPillColumn,
} from "../_components/data-table/columnHelpers";
import Link from "next/link";
import { entities } from "~/entities/entities";
import { useEntityList } from "../_components/hooks/useEntityList";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";

/** Aggregate unit mappings from all products for an ingredient */
async function getIngredientMappings(
  ingredient: IngredientWithFoodOut,
): Promise<Awaited<ReturnType<typeof getAllUnitMappingsFromProduct>>> {
  const results = await Promise.all(
    ingredient.product.map((p) => getAllUnitMappingsFromProduct(p)),
  );
  return results.flat();
}

export function IngredientList() {
  const api = useTRPC();
  const columnHelper = createColumnHelper<IngredientWithFoodOut>();

  // Global filter for missing products
  const [globalFilter, setGlobalFilter] = useState({
    missingProductsOnly: false,
  });

  const { table, filterableColumns, isLoading, error } = useEntityList({
    entity: "ingredient",
    queryOptions: api.ingredient.list.queryOptions,
    buildFilters: (ts) => ({
      nameFilter: ts.getColumnFilter("name"),
      missingProductsOnly: globalFilter.missingProductsOnly,
    }),
    getMappings: getIngredientMappings,
    // Ingredient has custom column order (selection first), so we define all columns
    // Unit mappings column is added automatically by hook via hasUnitMappings config
    columns: [
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
    ],
    filters: [{ id: "name", placeholder: "Filter by ingredient name..." }],
    globalFilter,
    onGlobalFilterChange: setGlobalFilter as (value: unknown) => void,
  });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <IngredientMerger table={table} />
        <Button
          variant="default"
          render={<Link href={`/${entities.ingredient.basePath}/new`} />}
        >
          Create New Ingredient
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
              className="font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Missing Products Only
            </label>
          </div>
        }
      />
    </div>
  );
}
