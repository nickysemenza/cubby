"use client";

import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { type Flatten } from "~/misc/array-helpers";
import { SectionIngredientOut } from "~/schemas/recipe";
import RTable from "../data-table/Table";
import { getAllUnitMappingsFromProduct } from "~/schemas/combo";
import { type IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useMemo } from "react";
import { useWasm } from "~/hooks/useWasm";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import { renderValueOrError } from "~/misc/result";
import {
  calculateTotals,
  createIngredientData,
} from "~/app/_components/units/univ-conversion";
import { NutrientsSummary } from "~/app/_components/units/NutrientsSummary";
import { tryFormatMeasure } from "../inventory/format-amount";
import { IngredientPillLink, RecipePillLink } from "../EntityPill";
import {
  EntitySummaryCard,
  type RecipeSummaryData,
} from "~/components/ui/entity-summary-card";
import { getIngredientName } from "./recipeutils";

export const RecipeIngredientList: React.FC<{
  ingredients: SectionIngredientOut[];
  ingMap: Record<string, IngredientWithFoodOut> | undefined;
}> = ({ ingredients, ingMap }) => {
  const w = useWasm();
  const data = useMemo(() => {
    return ingMap ? createIngredientData(w, ingredients, ingMap) : [];
  }, [ingredients, ingMap, w]);

  const columnHelper = createColumnHelper<Flatten<typeof data>>();

  const columns = [
    columnHelper.accessor((ingredient) => getIngredientName(ingredient), {
      id: "ing name",
      header: "Ingredient",
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("amounts", {
      header: "Amounts",
      cell: (info) => {
        const amounts = info.getValue();

        // Format each amount using tryFormatMeasure
        return (
          <div className="space-y-0.5 text-sm">
            {amounts.map((amount, index) => (
              <div key={index}>{tryFormatMeasure(w, amount)}</div>
            ))}
          </div>
        );
      },
    }),
    columnHelper.display({
      id: "dollars",
      header: "Cost",
      cell: (props) => {
        const measure = props.row.original.priceInfo?.price;
        return (
          measure && renderValueOrError(measure, (m) => tryFormatMeasure(w, m))
        );
      },
    }),
    columnHelper.display({
      id: "grams",
      header: "Weight",
      cell: (props) => {
        const measure = props.row.original.priceInfo?.gram;
        return (
          measure && renderValueOrError(measure, (m) => tryFormatMeasure(w, m))
        );
      },
    }),
    columnHelper.display({
      id: "nutrient",
      header: "Nutrition",
      cell: (props) => {
        const nutrientResult = props.row.original.priceInfo?.nutrient;
        return (
          nutrientResult &&
          renderValueOrError(nutrientResult, (nutrients) => (
            <NutrientsSummary nutrients={nutrients} />
          ))
        );
      },
    }),
    columnHelper.display({
      id: "ingredientDetails",
      header: "Ingredient Details",
      cell: (props) => {
        const row = props.row.original;

        if (row.type === "ingredient") {
          return (
            <IngredientPillLink
              name={row.ingredient.name}
              id={row.ingredient.id}
            />
          );
        } else if (row.type === "recipe") {
          return <RecipePillLink recipe={row.recipe} />;
        }

        return null;
      },
    }),
    columnHelper.display({
      id: "mappings",
      header: "Unit Mappings",
      cell: (props) => {
        if (ingMap === undefined) {
          return "loading";
        }

        const row = props.row.original;
        let id = undefined;

        if (row.type === "ingredient") {
          id = row.ingredient.id;
        }

        const entry = id ? ingMap[id] : undefined;
        const mappings =
          entry?.product?.flatMap(getAllUnitMappingsFromProduct) || [];
        return <UnitMappingDisplay mappings={mappings} title="" />;
      },
    }),
  ];

  const table = useReactTable({
    data: data,
    columns,
    enableSorting: false,
    enableFilters: false,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    rowCount: ingredients.length,
    state: {
      pagination: {
        pageSize: ingredients.length,
        pageIndex: 0,
      },
    },
  });

  const totalPrice = useMemo(() => {
    return ingMap && calculateTotals(w, ingredients, ingMap, getIngredientName);
  }, [ingMap, ingredients, w]);

  // Convert totals to RecipeSummaryData format
  const getRecipeSummaryData = (
    totals: ReturnType<typeof calculateTotals>,
  ): RecipeSummaryData => ({
    price: totals.price,
    weight: totals.weight,
    kcal: totals.kcal,
    protein: totals.protein,
    totalIngredients: totals.totalIngredients,
    missingByType: totals.missingByType,
  });

  return (
    <div>
      {totalPrice && (
        <EntitySummaryCard
          title="Recipe Summary"
          summaryData={{
            type: "recipe",
            data: getRecipeSummaryData(totalPrice),
          }}
        />
      )}
      <RTable
        table={table}
        filterableColumns={[]}
        isLoading={data.length === 0}
        error={undefined}
        ariaLabel="Recipe Ingredients Table"
      />
    </div>
  );
};
