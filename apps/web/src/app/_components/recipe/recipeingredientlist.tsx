"use client";

import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { SectionIngredientOut } from "~/schemas/recipe";
import RTable from "../data-table/Table";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { type IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useState, useEffect } from "react";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import { renderValueOrError } from "~/misc/result";
import {
  calculateTotals,
  createIngredientData,
  type CalculateTotalsResult,
  type IngredientDataItem,
} from "~/app/_components/units/univ-conversion";
import { NutrientsSummary } from "~/app/_components/units/NutrientsSummary";
import { tryFormatMeasure } from "../inventory/format-amount";
import { IngredientPillLink, RecipePillLink } from "../EntityPill";
import {
  EntitySummaryCard,
  type RecipeSummaryData,
} from "~/components/ui/entity-summary-card";
import { getIngredientName } from "./recipeutils";
import { type UnitMapping } from "~/schemas/unitmapping";

type RecipeIngredientState = {
  data: IngredientDataItem[];
  mappingsMap: Record<string, UnitMapping[]>;
  totals: CalculateTotalsResult | undefined;
};

export const RecipeIngredientList: React.FC<{
  ingredients: SectionIngredientOut[];
  ingMap: Record<string, IngredientWithFoodOut> | undefined;
}> = ({ ingredients, ingMap }) => {
  // Load all async data in one effect
  const [state, setState] = useState<RecipeIngredientState>({
    data: [],
    mappingsMap: {},
    totals: undefined,
  });

  useEffect(() => {
    if (!ingMap) {
      setState({ data: [], mappingsMap: {}, totals: undefined });
      return;
    }

    const load = async () => {
      const data = await createIngredientData(ingredients, ingMap);
      const totals = await calculateTotals(ingredients, ingMap, getIngredientName);

      // Build mappings map
      const mappingsMap: Record<string, UnitMapping[]> = {};
      for (const [id, entry] of Object.entries(ingMap)) {
        const mappings: UnitMapping[] = [];
        for (const p of entry.product ?? []) {
          mappings.push(...(await getAllUnitMappingsFromProduct(p)));
        }
        mappingsMap[id] = mappings;
      }

      setState({ data, mappingsMap, totals });
    };
    void load();
  }, [ingredients, ingMap]);

  const { data, mappingsMap, totals } = state;

  const columnHelper = createColumnHelper<IngredientDataItem>();

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
              <div key={index}>{tryFormatMeasure(amount)}</div>
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
          measure && renderValueOrError(measure, (m) => tryFormatMeasure(m))
        );
      },
    }),
    columnHelper.display({
      id: "grams",
      header: "Weight",
      cell: (props) => {
        const measure = props.row.original.priceInfo?.gram;
        return (
          measure && renderValueOrError(measure, (m) => tryFormatMeasure(m))
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
        let id: string | undefined = undefined;

        if (row.type === "ingredient") {
          id = row.ingredient.id;
        }

        const mappings = id ? mappingsMap[id] ?? [] : [];
        return <UnitMappingDisplay mappings={mappings} title="" />;
      },
    }),
  ];

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table API limitation
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

  // Convert totals to RecipeSummaryData format
  const getRecipeSummaryData = (t: CalculateTotalsResult): RecipeSummaryData => ({
    price: t.price,
    weight: t.weight,
    kcal: t.kcal,
    protein: t.protein,
    totalIngredients: t.totalIngredients,
    missingByType: t.missingByType,
  });

  return (
    <div>
      {totals && (
        <EntitySummaryCard
          title="Recipe Summary"
          summaryData={{
            type: "recipe",
            data: getRecipeSummaryData(totals),
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
