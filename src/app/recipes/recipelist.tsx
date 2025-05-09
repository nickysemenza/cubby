"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/util";
import RTable from "../_components/data-table/Table";
import { useTableState } from "../_components/data-table/useTableState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createNameColumn,
  createCreatedAtColumn,
} from "../_components/data-table/columnHelpers";

import { useQuery } from "@tanstack/react-query";

export function RecipeList() {
  const api = useTRPC();
  // Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });

  // Query data with params from table state
  const { data: recipesResp, isLoading } = useQuery(
    api.recipe.list.queryOptions({
      sort: tableState.getSortParams(),
      pagination: tableState.pagination,
      filters: {
        nameFilter: tableState.getColumnFilter("name"),
      },
    }),
  );

  // Set up columns using helpers
  const data = recipesResp?.items || [];
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    createNameColumn(columnHelper, "recipes"),
    createCreatedAtColumn(columnHelper),
    columnHelper.accessor("meta", {
      enableSorting: false,
      cell: (info) => info.getValue()?.url,
    }),
  ];

  // Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount: recipesResp?.meta?.totalCount || 0,
  });

  const filterableColumns = [
    { id: "name", placeholder: "Filter by recipe name..." },
    { id: "meta", placeholder: "Filter by source..." },
  ];

  return (
    <div>
      <RTable
        table={table}
        filterableColumns={filterableColumns}
        isLoading={isLoading}
      />
    </div>
  );
}
