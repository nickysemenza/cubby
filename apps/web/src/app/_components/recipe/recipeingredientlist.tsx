import type { SectionIngredientOut } from "@cubby/schemas/recipe";
import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo } from "react";
import { NutrientsSummary } from "~/app/_components/units/NutrientsSummary";
import {
  EntitySummaryCard,
  type RecipeSummaryData,
} from "~/components/entity/entity-summary-card";
import {
  type CalculateTotalsResult,
  calculateTotals,
  createIngredientData,
  type IngredientDataItem,
} from "~/lib/recipe-costing";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { renderValueOrMissing } from "~/misc/result";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { createActionsColumnBase } from "../data-table/columnHelpers";
import RTable from "../data-table/Table";
import { EntityPillLink } from "../EntityPill";
import { tryFormatAmount } from "../inventory/format-amount";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import { getIngredientName } from "./recipe-utils";

export const RecipeIngredientList: React.FC<{
  ingredients: SectionIngredientOut[];
  ingMap: Record<string, IngredientWithFoodOut> | undefined;
}> = ({ ingredients, ingMap }) => {
  // Load ingredient data
  const data = useMemo(
    () => (ingMap ? createIngredientData(ingredients, ingMap) : []),
    [ingredients, ingMap],
  );

  // Load totals
  const totals = useMemo(
    () =>
      ingMap
        ? calculateTotals(ingredients, ingMap, getIngredientName)
        : undefined,
    [ingredients, ingMap],
  );

  // Load unit mappings
  const mappingsMap = useMemo(() => {
    if (!ingMap) return {};
    const entries = Object.entries(ingMap).map(([id, entry]) => {
      const productMappings = (entry.product ?? []).flatMap((p) =>
        getAllUnitMappingsFromProduct(p),
      );
      return [id, productMappings] as const;
    });
    return Object.fromEntries(entries);
  }, [ingMap]);

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

        // Format each amount using tryFormatAmount
        return (
          <div className="space-y-0.5 text-sm">
            {amounts.map((amount, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: amounts are positional without stable IDs
              <div key={index}>{tryFormatAmount(amount)}</div>
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
          measure && renderValueOrMissing(measure, (m) => tryFormatAmount(m))
        );
      },
    }),
    columnHelper.display({
      id: "grams",
      header: "Weight",
      cell: (props) => {
        const measure = props.row.original.priceInfo?.gram;
        return (
          measure && renderValueOrMissing(measure, (m) => tryFormatAmount(m))
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
          renderValueOrMissing(nutrientResult, (nutrients) => (
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
            <EntityPillLink
              entity="ingredient"
              data={{
                name: row.ingredient.name,
                id: row.ingredient.id,
              }}
              compact
            />
          );
        } else if (row.type === "recipe") {
          return <EntityPillLink entity="recipe" data={row.recipe} compact />;
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
        let id: string | undefined;

        if (row.type === "ingredient") {
          id = row.ingredient.id;
        }

        const mappings = id ? (mappingsMap[id] ?? []) : [];
        return <UnitMappingDisplay mappings={mappings} title="" compact />;
      },
    }),
    // Actions column - links to ingredient or recipe detail
    createActionsColumnBase(columnHelper, (row) => {
      if (row.type === "ingredient") {
        return { to: "/ingredients/$id", params: { id: row.ingredient.id } };
      }
      if (row.type === "recipe") {
        return { to: "/recipes/$id", params: { id: row.recipe.id } };
      }
      return null;
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

  // Convert totals to RecipeSummaryData format
  const getRecipeSummaryData = (
    t: CalculateTotalsResult,
  ): RecipeSummaryData => ({
    price: t.price,
    weight: t.weight,
    nutrients: t.nutrients,
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
        isLoading={data.length === 0}
        error={undefined}
        ariaLabel="Recipe Ingredients Table"
      />
    </div>
  );
};
