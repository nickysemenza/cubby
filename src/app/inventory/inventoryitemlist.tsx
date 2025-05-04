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
import { useState } from "react";
import {
  buildSortParams,
  defaultPagination,
  defaultSortState,
} from "../_components/data-table/tableUtils";
import JsonRenderer from "../_components/json-renderer";
import { LocationPillLink, ProductPillLink } from "../_components/EntityPill";
import { buildunitMappingsGraph } from "../_components/units/UnitMappingGraph";
import { useWasm } from "~/wasmContext";
import { showAmountAndPrice } from "../_components/inventory/format-amount";

dayjs.extend(relativeTime);

export function InventoryItemList() {
  const initialSort = "createdAt";
  const [sorting, setSorting] = useState(defaultSortState(initialSort));
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [pagination, setPagination] = useState(defaultPagination);
  const [inventoryitemsResp] = api.inventoryItem.list.useSuspenseQuery({
    sort: buildSortParams(sorting, initialSort),
    pagination,
  });
  const { w } = useWasm();
  const data = inventoryitemsResp.items;
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    columnHelper.accessor("product", {
      enableSorting: false,
      cell: (info) => {
        const product = info.getValue();
        const { upc, ndb_number, unitMappings } = product;
        return (
          <>
            <JsonRenderer input={{ upc, ndb_number }} />
            <div>{w && buildunitMappingsGraph(w, unitMappings)}</div>
            <ProductPillLink product={product} />
          </>
        );
      },
    }),
    columnHelper.accessor("location", {
      enableSorting: false,
      cell: (info) => {
        const item = info.getValue();
        return (
          <>
            <LocationPillLink location={item} />
          </>
        );
      },
    }),
    columnHelper.accessor("amount", {
      cell: (info) => {
        return (
          w &&
          showAmountAndPrice(
            w,
            info.getValue(),
            info.row.original.product.unitMappings,
          )
        );
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
            href={`inventory/${info.getValue()}`}
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
    rowCount: inventoryitemsResp.meta.totalCount,
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
