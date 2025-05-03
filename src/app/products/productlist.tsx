"use client";

import { api } from "~/trpc/react";
import {
  type ColumnFiltersState,
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { type Flatten } from "~/misc/util";
import RTable from "../_components/data-table/Table";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import Link from "next/link";
import React, { useState } from "react";
import {
  buildSortParams,
  defaultPagination,
  defaultSortState,
} from "../_components/data-table/tableUtils";
import { IngredientPillLink } from "../_components/EntityPill";
import { useWasm } from "~/wasmContext";
import { buildunitMappingsGraph } from "../_components/units/UnitMappingGraph";
import JsonRenderer from "../_components/json-renderer";
import { UnitMapping } from "~/schemas/unitmapping";
import { unitMappignsFromProduct } from "~/schemas/combo";
import { NutritionInfoTable } from "../_components/usda/nutrition";
import { UnitMappingsTable } from "../_components/units/unitmappingstable";

dayjs.extend(relativeTime);

export function ProductList() {
  const initialSort = "createdAt";
  const [sorting, setSorting] = useState(defaultSortState(initialSort));
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [pagination, setPagination] = useState(defaultPagination);
  const [productsResp] = api.product.list.useSuspenseQuery({
    sort: buildSortParams(sorting, initialSort),
    pagination,
    nameFilter: columnFilters.find((filter) => filter.id === "name")?.value as
      | string
      | undefined,
  });
  const { w } = useWasm();

  const data = productsResp.items;
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    columnHelper.accessor("name", {
      cell: (info) => {
        const ingredient = info.row.original.ingredient;
        return (
          <div className="flex flex-col">
            <Link
              className="font-medium text-blue-600 hover:underline dark:text-blue-500"
              href={`products/${info.getValue()}`}
            >
              {info.getValue()}
            </Link>
            {ingredient && (
              <IngredientPillLink name={ingredient.name} id={ingredient.id} />
            )}
          </div>
        );
      },
    }),
    columnHelper.accessor("manufacturer", {
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("upc", {
      cell: (info) => {
        const upc = info.getValue();
        return upc && <code>{upc}</code>;
      },
    }),
    columnHelper.accessor("ndb_number", {
      header: "NDB",
      cell: (info) => info.getValue() && <code>{info.getValue()}</code>,
    }),
    columnHelper.accessor("model", {
      cell: (info) => info.getValue() && <code>{info.getValue()}</code>,
    }),
    columnHelper.accessor("food", {
      id: "food info",
      cell: (info) => {
        const food = info.getValue();
        if (!food) return "❌";
        const { nutritionInfo } = food;
        return (
          <div className="w-64">
            <NutritionInfoTable n={nutritionInfo} limit={5} />
          </div>
        );
      },
    }),
    columnHelper.accessor("unitMappings", {
      enableSorting: false,
      cell: (info) => {
        const mappings: UnitMapping[] = unitMappignsFromProduct(
          info.row.original,
        );
        return (
          w && (
            <>
              {buildunitMappingsGraph(w, mappings)}
              <div className="w-60">
                <UnitMappingsTable mappings={mappings} w={w} />
              </div>
            </>
          )
        );
      },
    }),

    columnHelper.accessor("inventoryEntry", {
      enableSorting: false,
      cell: (info) => {
        return <JsonRenderer input={info.getValue()} />;
      },
    }),

    columnHelper.accessor("createdAt", {
      cell: (info) => dayjs(info.getValue()).fromNow(),
    }),
  ];
  const table = useReactTable({
    data: data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    rowCount: productsResp.meta.totalCount,
    state: {
      sorting,
      columnFilters,
      pagination,
    },
  });

  return (
    <div>
      <RTable table={table} />
    </div>
  );
}
