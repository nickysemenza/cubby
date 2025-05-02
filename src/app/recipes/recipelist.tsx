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
  defaultPagination,
  buildSortParams,
  defaultSortState,
} from "../_components/data-table/tableUtils";

dayjs.extend(relativeTime);

export function RecipeList() {
  const initialSort = "createdAt";
  const [sorting, setSorting] = useState(defaultSortState(initialSort));
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [pagination, setPagination] = useState(defaultPagination);
  const [recipesResp] = api.recipe.list.useSuspenseQuery({
    sort: buildSortParams(sorting, initialSort),
    pagination,
    nameFilter: columnFilters.find((filter) => filter.id === "name")?.value as
      | string
      | undefined,
  });
  const data = recipesResp.items;
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    columnHelper.accessor("name", {
      cell: (info) => (
        <Link
          className="text-blue-600 hover:underline dark:text-blue-500"
          href={`recipes/${info.row.original.id}`}
        >
          {info.getValue()}
        </Link>
      ),
    }),

    columnHelper.accessor("createdAt", {
      cell: (info) => dayjs(info.getValue()).fromNow(),
    }),
    columnHelper.accessor("meta", {
      enableSorting: false,
      cell: (info) => info.getValue()?.url,
    }),
    columnHelper.accessor("id", {
      enableSorting: false,
      cell: (info) => (
        <div>
          <Link
            className="group-selected:bg-slate-700 group-selected:border-slate-800 rounded-sm border border-slate-200 bg-slate-100 px-1 font-mono font-medium text-blue-600 hover:underline dark:text-blue-500"
            href={`recipes/${info.getValue()}`}
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
    rowCount: recipesResp.meta.totalCount,
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
