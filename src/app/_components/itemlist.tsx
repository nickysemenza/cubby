"use client";

import { api } from "~/trpc/react";
import {
  type ColumnFiltersState,
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { type Flatten } from "~/util";
import RTable, { Toolbar } from "./Table";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import Link from "next/link";
import { useState } from "react";
import { type SortParams } from "~/server/api/routers/util";

dayjs.extend(relativeTime);

export function ItemList() {
  const initialSort = "createdAt";
  const [sorting, setSorting] = useState<SortingState>([
    { id: initialSort, desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const sortParams: SortParams = {
    direction: sorting[0]?.desc ? "desc" : "asc",
    orderBy: sorting[0]?.id ?? initialSort,
  };
  const [pagination, setPagination] = useState({
    pageIndex: 0, //initial page index
    pageSize: 10, //default page size
  });
  const [itemsResp] = api.item.list.useSuspenseQuery({
    sort: sortParams,
    pagination,
    nameFilter: columnFilters.find((filter) => filter.id === "name")?.value as
      | string
      | undefined,
  });

  const items = itemsResp.items;
  const columnHelper = createColumnHelper<Flatten<typeof items>>();
  console.log({ sorting, columnFilters });
  const columns = [
    // {
    //   id: "select",
    //   header: () => <SelectionCheckbox />,
    //   cell: () => <SelectionCheckbox />,
    //   enableSorting: false,
    //   enableHiding: false,
    // },
    columnHelper.accessor("name", {
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("type", {
      cell: (info) => info.getValue(),
    }),

    columnHelper.accessor("createdAt", {
      cell: (info) => dayjs(info.getValue()).fromNow(),
    }),
    columnHelper.accessor("id", {
      enableSorting: false,
      cell: (info) => (
        <div>
          <Link
            className="group-selected:bg-slate-700 group-selected:border-slate-800 rounded border border-slate-200 bg-slate-100 px-1 font-mono font-medium text-blue-600 hover:underline dark:text-blue-500"
            href={`items/${info.getValue()}`}
          >
            {info.getValue()}
          </Link>
        </div>
      ),
    }),
  ];
  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    rowCount: itemsResp.meta.totalCount,
    state: {
      sorting,
      columnFilters,
      pagination,
    },
  });

  return (
    <div>
      <Toolbar table={table} />
      <RTable table={table} sorting={sorting} />
    </div>
  );
}
