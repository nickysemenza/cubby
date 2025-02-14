"use client";

import { api } from "~/trpc/react";
import {
  type ColumnFiltersState,
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { type Flatten } from "~/util";
import RTable from "../_components/data-table/Table";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import Link from "next/link";
import React, { useContext, useState } from "react";
import {
  buildSortParams,
  defaultPagination,
  defaultSortState,
} from "../_components/data-table/tableUtils";
import { PillLink } from "../_components/EntityPill";
import { WasmContext } from "~/wasmContext";
import { buildunitMappingsGraph } from "../_components/UnitMappingGraph";
import JsonRenderer from "../_components/json";
import { UnitMapping } from "~/schemas/unitmapping";
import { unitMappignsFromProduct } from "~/schemas/combo";

dayjs.extend(relativeTime);
export const UPCView: React.FC<{ upc: string }> = ({ upc }) => {
  const { data } = api.usda.getByUPC.useQuery({ upc: upc });
  return (
    <div className="flex flex-col">
      <code>{upc}</code>
      {data?.foodInfo?.description || "❌"}
      {/* You can display additional data from the query if needed */}
    </div>
  );
};
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
  const w = useContext(WasmContext);

  const data = productsResp.items;
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    columnHelper.accessor("name", {
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("manufacturer", {
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("upc", {
      cell: (info) => {
        const upc = info.getValue();
        return upc && <UPCView upc={upc} />;
      },
    }),
    columnHelper.accessor("model", {
      cell: (info) => info.getValue() && <code>{info.getValue()}</code>,
    }),
    columnHelper.accessor("food", {
      id: "nutrients",
      cell: (info) => {
        const food = info.getValue();
        return <JsonRenderer input={food?.nutrientsPer100} />;
      },
    }),
    columnHelper.accessor("food", {
      id: "test123",
      cell: (info) => {
        const food = info.getValue();
        return <JsonRenderer input={food} />;
      },
    }),
    columnHelper.accessor("unitMappings", {
      enableSorting: false,
      cell: (info) => {
        const mappings: UnitMapping[] = unitMappignsFromProduct(
          info.row.original,
        );
        return (
          <>
            {buildunitMappingsGraph(w, mappings)}
            {w.test_convert_to_target(mappings, "money")}
            {mappings.map((unitMapping, x) => {
              return (
                <div key={x}>
                  {w.format_amount(unitMapping.a) +
                    " = " +
                    w.format_amount(unitMapping.b)}
                </div>
              );
            })}
          </>
        );
      },
    }),
    columnHelper.accessor("ingredient", {
      enableSorting: false,
      cell: (info) => {
        const ingredient = info.getValue();
        return (
          <div>
            {ingredient && (
              <PillLink
                text={ingredient.name}
                label="ingredient"
                href={`ingredients/${ingredient.id}`}
              />
            )}
          </div>
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
    columnHelper.accessor("id", {
      enableSorting: false,
      cell: (info) => (
        <div>
          <Link
            className="group-selected:bg-slate-700 group-selected:border-slate-800 rounded-sm border border-slate-200 bg-slate-100 px-1 font-mono font-medium text-blue-600 hover:underline dark:text-blue-500"
            href={`products/${info.getValue()}`}
          >
            {info.getValue()}
          </Link>
        </div>
      ),
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
