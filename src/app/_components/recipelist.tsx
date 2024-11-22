"use client";

import { api } from "~/trpc/react";
import JsonRenderer from "./json";
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

export function RecipeList() {
  const initialSort = "createdAt";
  const [sorting, setSorting] = useState<SortingState>([
    { id: initialSort, desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const sortParams: SortParams = {
    direction: sorting[0]?.desc ? "desc" : "asc",
    orderBy: (sorting[0]?.id ?? initialSort) as SortParams["orderBy"],
  };
  const [pagination, setPagination] = useState({
    pageIndex: 0, //initial page index
    pageSize: 10, //default page size
  });

  const [recipesResp] = api.recipe.list.useSuspenseQuery({
    sort: sortParams,
    pagination,
    nameFilter: columnFilters.find((filter) => filter.id === "name")?.value as
      | string
      | undefined,
  });
  const recipes = recipesResp.items;

  const columnHelper = createColumnHelper<Flatten<typeof recipes>>();
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
    columnHelper.display({
      id: "sections",
      cell: (info) => {
        return info.row.original.sections.map((section) => (
          <li key={section.id}>
            {section.name}
            <ul className="ml-4 list-inside list-disc">
              {section.ingredients.map((ingredient) => (
                <li key={ingredient.id}>
                  <div>
                    {ingredient.ingredient?.name}
                    <JsonRenderer input={ingredient.amounts} />
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ));
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
            className="group-selected:bg-slate-700 group-selected:border-slate-800 rounded border border-slate-200 bg-slate-100 px-1 font-mono font-medium text-blue-600 hover:underline dark:text-blue-500"
            href={`recipes/${info.getValue()}`}
          >
            {info.getValue()}
          </Link>
        </div>
      ),
    }),
  ];
  const table = useReactTable({
    data: recipes,
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
      <Toolbar table={table} />
      <RTable table={table} sorting={sorting} />
    </div>
  );
}
