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
import { IngredientOut } from "~/schemas/combo";
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
  for (const ingredient of ingredients) {
    const id = ingredient.ingredient?.id;
    const entry = id ? ingMap[id] : undefined;
    const mappings = entry?.product?.flatMap((p) => p.unitMappings) || [];
    const firstAmount = ingredient.amounts[0];
    const price =
      firstAmount &&
      w.convert_to_target_via_mappings(mappings, firstAmount, "money");

    prices.push(price);
  }
  // return prices.reduce((acc, curr) => acc + (curr || 0), 0);
  return prices;
};
export const RecipeIngredientList: React.FC<{
  ingredients: SectionIngredientOut[];
  ingMap: Record<string, IngredientOut>;
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
        const id = props.row.original.ingredient?.id;
        const entry = id ? ingMap[id] : undefined;
        const mappings = entry?.product?.flatMap((p) => p.unitMappings) || [];
        const firstAmount = props.row.original.amounts[0];
        return (
          <div>
            {firstAmount &&
              w.convert_to_target_via_mappings(mappings, firstAmount, "money")}
            {buildunitMappingsGraph(w, mappings)}
            {/* <JsonRenderer input={entry?.product} />; */}
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

  const totalPrice = sumPrice(w, ingredients, ingMap);
  return (
    <div>
      a
      <JsonRenderer input={totalPrice} />
      <RTable table={table} />
    </div>
  );
};
