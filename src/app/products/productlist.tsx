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
import { useContext, useState } from "react";
import {
  buildSortParams,
  defaultPagination,
  defaultSortState,
} from "../_components/data-table/tableUtils";
import { PillLink } from "../_components/EntityPill";
import { type WUnitMapping } from "recipebridge/pkg";

// https://nextjs.org/docs/pages/building-your-application/optimizing/lazy-loading#with-no-ssr
import dynamic from "next/dynamic";
import JsonRenderer from "../_components/json";
import { wasm, WasmContext } from "~/wasmContext";
const Graphviz = dynamic(() => import("graphviz-react"), { ssr: false });

dayjs.extend(relativeTime);

const buildunitMappingsGraph = (w: wasm, unitMapping: WUnitMapping[]) => {
  try {
    const graph = w
      .graph_unit_mappings(unitMapping)
      .replace(
        "digraph {",
        `digraph { rankdir=LR; nodesep=0.5;bgcolor="transparent";`,
      );

    return (
      <Graphviz
        dot={graph}
        options={{ width: 200, height: 100, background: "transparent" }}
        className="w-full"
      />
    );
  } catch (e) {
    const error = e as string;
    return <div className="text-red-400">{error}</div>;
  }
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
      cell: (info) => info.getValue() && <code>{info.getValue()}</code>,
    }),
    columnHelper.accessor("model", {
      cell: (info) => info.getValue() && <code>{info.getValue()}</code>,
    }),
    columnHelper.accessor("unitMappings", {
      enableSorting: false,
      cell: (info) => (
        <>
          {buildunitMappingsGraph(w, info.getValue())}
          {w.test_convert_to_target(info.getValue(), "money")}
          {info.getValue().map((unitMapping, x) => {
            return (
              <div key={x}>
                {w.format_amount(unitMapping.a) +
                  " = " +
                  w.format_amount(unitMapping.b)}
              </div>
            );
          })}
        </>
      ),
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
      <RTable table={table} sorting={sorting} />
    </div>
  );
}
