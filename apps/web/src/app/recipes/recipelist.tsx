import { createColumnHelper } from "@tanstack/react-table";
import type { RecipeOut } from "~/schemas/recipe";
import { useTRPC } from "~/trpc/react";
import RTable from "../_components/data-table/Table";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";

export function RecipeList() {
  const api = useTRPC();
  const columnHelper = createColumnHelper<RecipeOut>();
  const { onRowClick, PreviewSheet } = useEntityPreview("recipe");

  const { table, filterableColumns, isLoading, error, timing } = useEntityList({
    entity: "recipe",
    queryOptions: api.recipe.list.queryOptions,
    buildFilters: (ts) => ({
      nameFilter: ts.getColumnFilter("name"),
    }),
    // Recipe uses standard columns (image, name, createdAt) plus custom meta column
    columns: [
      columnHelper.accessor("meta", {
        enableSorting: false,
        cell: (info) => info.getValue()?.url,
      }),
    ],
    filters: [
      { id: "name", placeholder: "Filter by recipe name..." },
      { id: "meta", placeholder: "Filter by source..." },
    ],
  });

  return (
    <div>
      <RTable
        table={table}
        filterableColumns={filterableColumns}
        isLoading={isLoading}
        error={error}
        ariaLabel="Recipes Table"
        timing={timing}
        entity="recipe"
        onRowClick={onRowClick}
      />
      <PreviewSheet />
    </div>
  );
}
