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
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import Link from "next/link";
import { useState } from "react";
import {
  buildSortParams,
  defaultPagination,
  defaultSortState,
} from "../_components/data-table/tableUtils";
import { PillLink } from "../_components/EntityPill";
import RTable from "../_components/data-table/Table";

dayjs.extend(relativeTime);

export function IngredientList() {
  const initialSort = "createdAt";
  const [sorting, setSorting] = useState(defaultSortState(initialSort));
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [pagination, setPagination] = useState(defaultPagination);
  const [ingredientsResp] = api.ingredient.list.useSuspenseQuery({
    sort: buildSortParams(sorting, initialSort),
    pagination,
    nameFilter: columnFilters.find((filter) => filter.id === "name")?.value as
      | string
      | undefined,
  });

  const data = ingredientsResp.items;
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    columnHelper.accessor("name", {
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("aliases", {
      cell: (info) => (
        <div>
          {info.getValue().map((alias) => (
            <div key={alias}>{alias}</div>
          ))}
        </div>
      ),
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
            href={`ingredients/${info.getValue()}`}
          >
            {info.getValue()}
          </Link>
        </div>
      ),
    }),
    columnHelper.accessor("appearsInRecipes", {
      cell: (info) => (
        <div>
          <ul className="">
            {info
              .getValue()
              .filter(
                (obj1, i, arr) =>
                  arr.findIndex((obj2) => obj2.id === obj1.id) === i,
              )
              .map((recipe) => (
                <li key={recipe.id}>
                  <PillLink
                    text={recipe.name}
                    label="recipe"
                    href={`recipes/${recipe.id}`}
                  />
                </li>
              ))}
          </ul>
        </div>
      ),
    }),
    columnHelper.accessor("product", {
      cell: (info) => (
        <div>
          <ul className="">
            {info.getValue().map((product) => (
              <li key={product.id}>
                <PillLink
                  text={`${product.name} (${product.manufacturer})`}
                  label="product"
                  href={`products/${product.id}`}
                />
              </li>
            ))}
          </ul>
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
    rowCount: ingredientsResp.meta.totalCount,
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
