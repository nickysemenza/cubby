"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import RTable from "../_components/data-table/Table";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createNameColumn,
  createCreatedAtColumn,
  createImageColumn,
} from "../_components/data-table/columnHelpers";
import { useTableList } from "../_components/hooks/useTableList";
import { type RecipeOut } from "~/schemas/recipe";

export function RecipeList() {
  const api = useTRPC();

  const { data, totalCount, isLoading, error, tableState } = useTableList<
    { nameFilter: string | undefined },
    RecipeOut
  >({
    queryOptions: api.recipe.list.queryOptions,
    buildFilters: (tableState) => ({
      nameFilter: tableState.getColumnFilter("name"),
    }),
    tableStateOptions: { initialSort: "createdAt" },
  });

  // Set up columns using helpers
  const columnHelper = createColumnHelper<RecipeOut>();
  const columns = [
    createImageColumn(columnHelper),
    createNameColumn(columnHelper, "recipe"),
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
    totalCount,
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
        error={error}
        ariaLabel="Recipes Table"
      />
    </div>
  );
}
