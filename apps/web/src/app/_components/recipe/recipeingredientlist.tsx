import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { NutrientsSummary } from "~/app/_components/units/NutrientsSummary";
import {
  type CalculateTotalsResult,
  calculateTotals,
  createIngredientData,
  type IngredientDataItem,
} from "~/app/_components/units/univ-conversion";
import {
  EntitySummaryCard,
  type RecipeSummaryData,
} from "~/components/entity/entity-summary-card";
import { useAsyncMemo } from "~/hooks/useAsyncMemo";
import { renderValueOrError } from "~/misc/result";
import type { SectionIngredientOut } from "~/schemas/recipe";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import RTable from "../data-table/Table";
import { IngredientPillLink, RecipePillLink } from "../EntityPill";
import { tryFormatAmount } from "../inventory/format-amount";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import { getIngredientName } from "./recipeutils";

export const RecipeIngredientList: React.FC<{
  ingredients: SectionIngredientOut[];
  ingMap: Record<string, IngredientWithFoodOut> | undefined;
}> = ({ ingredients, ingMap }) => {
  // Load ingredient data asynchronously
  const data = useAsyncMemo(
    async () => (ingMap ? createIngredientData(ingredients, ingMap) : []),
    [ingredients, ingMap],
    [],
  );

  // Load totals asynchronously
  const totals = useAsyncMemo(
    async () =>
      ingMap
        ? calculateTotals(ingredients, ingMap, getIngredientName)
        : undefined,
    [ingredients, ingMap],
    undefined,
  );

  // Load unit mappings asynchronously (parallelized)
  const mappingsMap = useAsyncMemo(
    async (signal) => {
      if (!ingMap) return {};
      const entries = await Promise.all(
        Object.entries(ingMap).map(async ([id, entry]) => {
          const productMappings = await Promise.all(
            (entry.product ?? []).map((p) => getAllUnitMappingsFromProduct(p)),
          );
          return [id, productMappings.flat()] as const;
        }),
      );
      if (signal.cancelled) return {};
      return Object.fromEntries(entries);
    },
    [ingMap],
    {},
  );

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
          measure && renderValueOrError(measure, (m) => tryFormatAmount(m))
        );
      },
    }),
    columnHelper.display({
      id: "grams",
      header: "Weight",
      cell: (props) => {
        const measure = props.row.original.priceInfo?.gram;
        return (
          measure && renderValueOrError(measure, (m) => tryFormatAmount(m))
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
        let id: string | undefined;

        if (row.type === "ingredient") {
          id = row.ingredient.id;
        }

        const mappings = id ? (mappingsMap[id] ?? []) : [];
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
        filterableColumns={[]}
        isLoading={data.length === 0}
        error={undefined}
        ariaLabel="Recipe Ingredients Table"
      />
    </div>
  );
};
