"use client";

import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { type Flatten } from "~/misc/util";
import { SectionIngredientOut } from "~/schemas/recipe";
import RTable from "../data-table/Table";
import {
  IngredientWithRecipesAndProductOut,
  unitMappignsFromProduct,
} from "~/schemas/combo";
import { useMemo } from "react";
import { useWasm } from "~/wasmContext";
import { buildunitMappingsGraph } from "../units/UnitMappingGraph";
import { renderValueOrError } from "~/misc/result";
import {
  renderNutrients,
  calculateTotals,
  createIngredientData,
} from "~/app/_components/units/univ-conversion";
import { tryFormatMeasure } from "../inventory/format-amount";
import { IngredientPillLink, RecipePillLink } from "../EntityPill";
import { SummaryCard, type SummaryItem } from "../SummaryCard";
import { getIngredientName } from "./recipeutils";

export const RecipeIngredientList: React.FC<{
  ingredients: SectionIngredientOut[];
  ingMap: Record<string, IngredientWithRecipesAndProductOut> | undefined;
}> = ({ ingredients, ingMap }) => {
  const { w } = useWasm();
  const data = useMemo(() => {
    return w && ingMap ? createIngredientData(w, ingredients, ingMap) : [];
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
            renderNutrients(nutrients),
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
    return (
      w && ingMap && calculateTotals(w, ingredients, ingMap, getIngredientName)
    );
  }, [ingMap, ingredients, w]);

  // Format the total price information
  const formatTotalPrice = (totals: ReturnType<typeof calculateTotals>) => {
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
