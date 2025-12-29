import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { getIngredientMappings } from "~/schemas/unit-mapping-utils";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
import {
  createCreatedAtColumn,
  createEntityPillColumn,
  createImageColumn,
  createNameColumn,
} from "../_components/data-table/columnHelpers";
import { buildSelectColumn } from "../_components/data-table/row-selection";
import RTable from "../_components/data-table/Table";
import { useEntityList } from "../_components/hooks/useEntityList";
import { TruncatedList } from "../_components/TruncatedList";
import { IngredientMerger } from "./ingredient-merger";

export function IngredientList() {
  const missingProductsId = useId();
  const api = useTRPC();
  const columnHelper = createColumnHelper<IngredientWithFoodOut>();

  // Global filter for missing products
  const [globalFilter, setGlobalFilter] = useState({
    missingProductsOnly: false,
  });

  const { table, isLoading, error, timing } = useEntityList({
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
      createNameColumn(columnHelper, "ingredient", "name", {
        filterConfig: { placeholder: "Filter by ingredient name..." },
      }),
      columnHelper.accessor("aliases", {
        header: "Aliases",
        cell: (info) => (
          <TruncatedList
            items={info.getValue()}
            maxItems={2}
            renderItem={(alias: string) => (
              <span key={alias} className="truncate text-xs">
                {alias}
              </span>
            )}
          />
        ),
      }),
      createCreatedAtColumn(columnHelper),
      createEntityPillColumn(columnHelper, "appearsInRecipes", "recipe", {
        header: "Recipes",
        className: "w-48 max-w-48",
        dedupe: true,
      }),
      createEntityPillColumn(columnHelper, "product", "product", {
        header: "Product",
        className: "w-48 max-w-48",
      }),
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
          render={<Link to="/ingredients/new" />}
          nativeButton={false}
        >
          Create New Ingredient
        </Button>
      </div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Ingredients Table"
        timing={timing}
        entity="ingredient"
        additionalToolbarContent={
          <div className="flex items-center space-x-2">
            <Checkbox
              id={missingProductsId}
              checked={table.getState().globalFilter.missingProductsOnly}
              onCheckedChange={(checked) =>
                table.setGlobalFilter({ missingProductsOnly: checked })
              }
            />
            <label
              htmlFor={missingProductsId}
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
