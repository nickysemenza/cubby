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
import { WasmContext } from "~/wasmContext";
import { buildunitMappingsGraph } from "../UnitMappingGraph";

dayjs.extend(relativeTime);

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
        return (
          <div>
            {w.test_convert_to_target(mappings, "money")}
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

  return (
    <div>
      <RTable table={table} />
    </div>
  );
};
