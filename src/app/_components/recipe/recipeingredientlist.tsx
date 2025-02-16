"use client";

import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { type Flatten } from "~/util";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { SectionIngredientOut } from "~/schemas/recipe";
import JsonRenderer from "../json";
import RTable from "../data-table/Table";
import {
  IngredientOut,
  test123,
  unitMappignsFromProduct,
} from "~/schemas/combo";
import { useContext } from "react";
import { wasm, WasmContext } from "~/wasmContext";
import { buildunitMappingsGraph } from "../UnitMappingGraph";

dayjs.extend(relativeTime);
const sumPrice = (
  w: wasm,
  ingredients: SectionIngredientOut[],
  ingMap: Record<string, IngredientOut>,
) => {
  const prices = [];
  const grams = [];
  const missing = [];
  const nutrients = [];
  for (const ingredient of ingredients) {
    try {
      const id = ingredient.ingredient?.id;
      const entry = id ? ingMap[id] : undefined;
      const product = entry?.product;
      const mappings =
        product?.flatMap((p) => unitMappignsFromProduct(p)) || [];
      const nutrientA = product
        ?.flatMap((p) => test123(p))
        .filter((x) => x !== undefined);
      const firstAmount = ingredient.amounts[0];
      if (firstAmount) {
        prices.push(
          w.convert_to_dollars_via_mappings(mappings, "money", firstAmount),
        );
        const gramsValue = w.convert_to_dollars_via_mappings(
          mappings,
          "weight",
          firstAmount,
        );
        grams.push(gramsValue);
        const firstNutrietn = nutrientA?.pop();
        if (firstNutrietn) {
          const protein = firstNutrietn.protein || 0;
          const proteinVal = (gramsValue.value / 100) * protein;
          nutrients.push(proteinVal); // Add proteinVal to nutrients
        }
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {}
    missing.push(ingredient.ingredient?.name);
  }
  return {
    price: prices.reduce((acc, curr) => acc + (curr.value || 0), 0),
    protein: nutrients.reduce((acc, curr) => acc + curr, 0),
    grams: grams.map((g) => g.value),
    prices: prices.map((g) => g.value),
    missing,
    nutrients,
  };
  // return prices;
};
export const RecipeIngredientList: React.FC<{
  ingredients: SectionIngredientOut[];
  ingMap: Record<string, IngredientOut> | undefined;
}> = ({ ingredients, ingMap }) => {
  const w = useContext(WasmContext);
  const data = ingredients;
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    columnHelper.accessor("amounts", {
      cell: (info) => {
        return <JsonRenderer input={info.getValue()} />;
      },
    }),
    columnHelper.accessor("ingredient", {
      cell: (info) => {
        return <JsonRenderer input={info.getValue()} />;
      },
    }),
    columnHelper.accessor(
      (ingredient) => ingredient.ingredient?.name || "Unknown",
      {
        id: "ing name",
        cell: (info) => info.getValue(),
      },
    ),
    columnHelper.display({
      id: "actions",
      cell: (props) => {
        if (ingMap === undefined) {
          return "loading";
        }
        const id = props.row.original.ingredient?.id;
        const entry = id ? ingMap[id] : undefined;
        const mappings =
          entry?.product?.flatMap((p) => unitMappignsFromProduct(p)) || [];
        // const firstAmount = props.row.original.amounts[0];
        return (
          <div>
            {/* {firstAmount &&
              w.convert_to_target_via_mappings(mappings, firstAmount, "money")} */}
            {buildunitMappingsGraph(w, mappings)}
          </div>
        );
      },
    }),

    columnHelper.accessor("createdAt", {
      cell: (info) => dayjs(info.getValue()).fromNow(),
    }),
  ];
  const table = useReactTable({
    data: data,
    columns,
    enableSorting: false,
    enableFilters: false,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    // manualSorting: true,
    // manualFiltering: true,
    // manualPagination: true,
    rowCount: ingredients.length,
    state: {
      pagination: {
        pageSize: ingredients.length,
        pageIndex: 0,
      },
    },
  });

  const totalPrice = ingMap && sumPrice(w, ingredients, ingMap);
  return (
    <div>
      <JsonRenderer input={totalPrice} />
      <RTable table={table} />
    </div>
  );
};
