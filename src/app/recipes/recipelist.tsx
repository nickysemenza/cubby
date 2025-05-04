"use client";

import { api } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/util";
import RTable from "../_components/data-table/Table";
import { useTableState } from "../_components/data-table/useTableState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createNameColumn,
  createCreatedAtColumn,
  createIdColumn,
} from "../_components/data-table/columnHelpers";

export function RecipeList() {
  // Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });

  // Query data with params from table state
  const [recipesResp] = api.recipe.list.useSuspenseQuery({
    sort: tableState.getSortParams(),
    pagination: tableState.pagination,
    nameFilter: tableState.getNameFilter(),
  });

  // Set up columns using helpers
  const data = recipesResp.items;
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    createNameColumn(columnHelper, "recipes"),
    createCreatedAtColumn(columnHelper),
    columnHelper.accessor("meta", {
      enableSorting: false,
      cell: (info) => info.getValue()?.url,
    }),
    createIdColumn(columnHelper, "recipes"),
  ];

  // Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount: recipesResp.meta.totalCount,
  });

  return (
    <div>
      <RTable table={table} />
    </div>
  );
}
