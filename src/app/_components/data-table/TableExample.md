# Table Component Usage Example

Here's how you could refactor the RecipeList component using the new helpers:

```tsx
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
  createUrlColumn,
  createIdColumn
} from "../_components/data-table/columnHelpers";

export function RecipeList() {
  // 1. Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });
  
  // 2. Query data with params from table state
  const [recipesResp] = api.recipe.list.useSuspenseQuery({
    sort: tableState.getSortParams(),
    pagination: tableState.pagination,
    nameFilter: tableState.getNameFilter(),
  });
  
  // 3. Set up columns using helpers
  const data = recipesResp.items;
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    createNameColumn(columnHelper, "recipes"),
    createCreatedAtColumn(columnHelper),
    createUrlColumn(columnHelper),
    createIdColumn(columnHelper, "recipes"),
  ];
  
  // 4. Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount: recipesResp.meta.totalCount,
  });

  // 5. Render the table
  return (
    <div>
      <RTable table={table} />
    </div>
  );
}
```

## Benefits of This Approach

1. **Less Boilerplate**: No need to repeat the same state initialization and table configuration code
2. **Consistency**: Common columns like ID, name, and creation date have consistent styling and behavior
3. **Type Safety**: Helpers are fully typed to ensure type safety across components
4. **Easier Maintenance**: Changes to columns styles or behavior can be made in one place
5. **Better Readability**: Code is more focused on the unique aspects of each table

## For More Complex Tables

For tables with custom filters or more complex behavior:

```tsx
export function IngredientList() {
  // 1. Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });
  
  // 2. Set up any custom filters
  const [globalFilter, setGlobalFilter] = useState({
    missingProductsOnly: false,
  });
  
  // 3. Query data with params
  const [ingredientsResp] = api.ingredient.list.useSuspenseQuery({
    sort: tableState.getSortParams(),
    pagination: tableState.pagination,
    nameFilter: tableState.getNameFilter(),
    missingProductsOnly: globalFilter.missingProductsOnly,
  });
  
  // 4. Set up columns - mix standard and custom columns
  const data = ingredientsResp.items;
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    buildSelectColumn<Flatten<typeof data>>(),
    createNameColumn(columnHelper, "ingredients"),
    // Custom column
    columnHelper.accessor("aliases", {
      cell: (info) => (
        <ul>
          {info.getValue().map((alias) => (
            <li key={alias}>{alias}</li>
          ))}
        </ul>
      ),
    }),
    createCreatedAtColumn(columnHelper),
    createIdColumn(columnHelper, "ingredients"),
    // More custom columns...
  ];
  
  // 5. Configure table with global filters
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount: ingredientsResp.meta.totalCount,
    globalFilter,
    onGlobalFilterChange: setGlobalFilter,
  });

  // 6. Render with additional filters
  return (
    <div>
      <IngredientMerger table={table} />
      <RTable
        table={table}
        additionalFilters={
          <div className="flex items-center space-x-2">
            <Checkbox
              id="missingProductsOnly"
              checked={table.getState().globalFilter.missingProductsOnly}
              onCheckedChange={(checked) =>
                table.setGlobalFilter({ missingProductsOnly: checked })
              }
            />
            <label
              htmlFor="missingProductsOnly"
              className="text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Missing Products Only
            </label>
          </div>
        }
      />
    </div>
  );
}
```