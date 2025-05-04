"use client";

import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Result, withFailure, type Flatten } from "~/misc/util";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { SectionIngredientOut } from "~/schemas/recipe";
import RTable from "../data-table/Table";
import { IngredientOut, unitMappignsFromProduct } from "~/schemas/combo";
import { useMemo } from "react";
import { useWasm, wasm } from "~/wasmContext";
import { buildunitMappingsGraph } from "../units/UnitMappingGraph";
import { WMeasure } from "recipebridge/pkg/recipebridge";
import { NutrientsPer100 } from "~/schemas/usda";
import { renderValueOrError } from "~/misc/result";
import {
  convertAmountToPrice,
  getGramAndNutrient,
} from "~/app/_components/units/univ-conversion";
import { tryFormatMeasure } from "../inventory/format-amount";
import { IngredientPillLink, RecipePillLink } from "../EntityPill";
import { SummaryCard, type SummaryItem } from "../SummaryCard";
import { getIngredientName } from "./recipeutils";

dayjs.extend(relativeTime);

const getPrice = (
  w: wasm,
  ingredient: SectionIngredientOut,
  ingMap: Record<string, IngredientOut>,
): {
  price: Result<WMeasure>;
  gram: Result<WMeasure>;
  nutrient: Result<NutrientsPer100>;
} => {
  // Handle based on ingredient type (discriminated union)
  const id =
    ingredient.type === "ingredient" ? ingredient.ingredient.id : undefined;
  const entry = id ? ingMap[id] : undefined;
  const product = entry?.product;
  const mappings = product?.flatMap((p) => unitMappignsFromProduct(p)) || [];
  const firstAmount = ingredient.amounts[0];
  // todo: should additional amounts be added to the mappings?

  if (!firstAmount) {
    const error = `ingredient ${ingredient.id} has no amounts`;
    return {
      price: withFailure(error),
      gram: withFailure(error),
      nutrient: withFailure(error),
    };
  }

  const price = convertAmountToPrice(w, firstAmount, mappings);
  const { gram, nutrient } = getGramAndNutrient(
    w,
    firstAmount,
    mappings,
    product,
  );

  return { price, gram, nutrient };
};

const sumPrice = (
  w: wasm,
  ingredients: SectionIngredientOut[],
  ingMap: Record<string, IngredientOut>,
) => {
  const prices: WMeasure[] = [];
  const grams: WMeasure[] = [];
  const missing = [];
  const nutrients: NutrientsPer100[] = [];
  for (const ingredient of ingredients) {
    const ingName = getIngredientName(ingredient);
    try {
      const { price, gram, nutrient } = getPrice(w, ingredient, ingMap);

      if (price.success) {
        prices.push(price.value);
      } else {
        missing.push(`price-${ingName}`);
      }
      if (gram.success) {
        grams.push(gram.value);
      } else {
        missing.push(`gram-${ingName}`);
      }
      if (nutrient.success) {
        nutrients.push(nutrient.value);
      } else {
        missing.push(`nutrient-${ingName}`);
      }
      continue;
    } catch (e) {
      console.log(`Error in getPrice for ${ingName}`, e);
      missing.push(ingName);
    }
  }
  return {
    price: prices.reduce((acc, curr) => acc + (curr.value || 0), 0),
    protein: nutrients.reduce((acc, curr) => acc + curr.protein, 0),
    kcal: nutrients.reduce((acc, curr) => acc + curr.kcal, 0),
    weight: grams.reduce((acc, curr) => acc + curr.value, 0),
    missing,
  };
  // return prices;
};

// Format nutrients in a user-friendly way
const formatNutrients = (nutrients: NutrientsPer100) => {
  return (
    <div className="space-y-1 text-sm">
      <div>
        <span className="font-medium">Calories:</span>{" "}
        {nutrients.kcal.toFixed(1)} kcal
      </div>
      <div>
        <span className="font-medium">Protein:</span>{" "}
        {nutrients.protein.toFixed(1)}g
      </div>
    </div>
  );
};

export const RecipeIngredientList: React.FC<{
  ingredients: SectionIngredientOut[];
  ingMap: Record<string, IngredientOut> | undefined;
}> = ({ ingredients, ingMap }) => {
  const { w } = useWasm();
  const data = useMemo(() => {
    return w
      ? ingredients.map((i) => ({
          ...i,
          priceInfo: ingMap && getPrice(w, i, ingMap),
        }))
      : [];
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
        if (!w) return "Loading...";
        const amounts = info.getValue();

        // Format each amount using tryFormatMeasure
        return (
          <div className="space-y-1">
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
          w &&
          measure &&
          renderValueOrError(measure, (m) => tryFormatMeasure(w, m))
        );
      },
    }),
    columnHelper.display({
      id: "grams",
      header: "Weight",
      cell: (props) => {
        const measure = props.row.original.priceInfo?.gram;
        return (
          w &&
          measure &&
          renderValueOrError(measure, (m) => tryFormatMeasure(w, m))
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
          renderValueOrError(nutrientResult, (nutrients) =>
            formatNutrients(nutrients),
          )
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
        if (ingMap === undefined || w === undefined) {
          return "loading";
        }

        const row = props.row.original;
        let id = undefined;

        if (row.type === "ingredient") {
          id = row.ingredient.id;
        }

        const entry = id ? ingMap[id] : undefined;
        const mappings =
          entry?.product?.flatMap((p) => unitMappignsFromProduct(p)) || [];
        return <div>{buildunitMappingsGraph(w, mappings)}</div>;
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
    return w && ingMap && sumPrice(w, ingredients, ingMap);
  }, [ingMap, ingredients, w]);

  // Format the total price information
  const formatTotalPrice = (totals: ReturnType<typeof sumPrice>) => {
    if (!w) return null;

    const summaryItems: SummaryItem[] = [
      {
        label: "Total Cost",
        value: totals.price,
        formatter: (value) => `$${Number(value).toFixed(2)}`,
      },
      {
        label: "Total Weight",
        value: totals.weight,
        formatter: (value) => `${Number(value).toFixed(0)}g`,
      },
      {
        label: "Total Calories",
        value: totals.kcal,
        formatter: (value) => `${Number(value).toFixed(0)} kcal`,
      },
      {
        label: "Total Protein",
        value: totals.protein,
        formatter: (value) => `${Number(value).toFixed(0)}g`,
      },
      {
        label: "Missing Data",
        value: totals.missing.join(", "),
      },
    ];

    return <SummaryCard title="Recipe Summary" items={summaryItems} />;
  };

  return (
    <div>
      {totalPrice && formatTotalPrice(totalPrice)}
      <RTable 
        table={table} 
        filterableColumns={[]} 
        isLoading={!w || data.length === 0} 
      />
    </div>
  );
};
