import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Merge } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { queryKeys } from "~/lib/query-keys";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useTRPC, useTRPCClient } from "~/trpc/react";
import {
  createCreatedAtColumn,
  createEntityPillColumn,
  createImageColumn,
  createNameColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { EntityPillLink } from "../_components/EntityPill";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { TruncatedList } from "../_components/TruncatedList";

export function IngredientList() {
  const missingProductsId = useId();
  const api = useTRPC();
  const trpcClient = useTRPCClient();
  const columnHelper = useMemo(
    () => createColumnHelper<IngredientWithFoodOut>(),
    [],
  );
  const { onRowClick, PreviewSheet } = useEntityPreview("ingredient");

  // Memoize invalidate keys to prevent recreating on every render
  const invalidateKeys = useMemo(
    () => [queryKeys.ingredient.list] as const,
    [],
  );

  // Memoize mutation function to prevent recreating on every render
  const mutationFn = useMemo(
    () => api.ingredient.update.mutationOptions,
    [api],
  );

  // Mutation for inline editing (name)
  const updateIngredientMutation = useUpdateMutation({
    mutationFn,
    entity: "ingredient",
    invalidateKeys,
  });

  // Global filter for missing products
  const [globalFilter, setGlobalFilter] = useState({
    missingProductsOnly: false,
  });

  // Memoize deletable config to prevent infinite render loop
  const deletableConfig = useDeletableConfig({
    mutationFn: api.ingredient.delete.mutationOptions,
    entityLabel: "Ingredient",
    invalidateKeys: [[queryKeys.ingredient.list]],
  });

  // Memoize columns to prevent recreating on every render
  // Note: updateIngredientMutation is NOT in dependencies because useMutation returns a new object every render
  // biome-ignore lint/correctness/useExhaustiveDependencies: updateIngredientMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      createImageColumn(columnHelper),
      createNameColumn(columnHelper, "ingredient", "name", {
        filterConfig: { placeholder: "Filter by ingredient name..." },
        editable: {
          onSave: async (newName, ingredient) => {
            await updateIngredientMutation.mutateAsync({
              id: ingredient.id,
              data: { name: newName },
            });
          },
        },
      }),
      columnHelper.accessor("aliases", {
        header: "Aliases",
        cell: (info) => (
          <TruncatedList
            items={info.getValue()}
            maxItems={2}
            renderItem={(alias: string) => (
              <span key={alias} className="truncate text-xs">
                {alias}
              </span>
            )}
          />
        ),
      }),
      createCreatedAtColumn(columnHelper),
      createEntityPillColumn(columnHelper, "appearsInRecipes", "recipe", {
        header: "Recipes",
        className: "w-48 max-w-48",
        dedupe: true,
      }),
      createEntityPillColumn(columnHelper, "product", "product", {
        header: "Product",
        className: "w-48 max-w-48",
      }),
    ],
    [columnHelper],
  );

  const { table, isLoading, error, timing, bulkActionBar, deleteDialog } =
    useEntityList({
      entity: "ingredient",
      queryOptions: api.ingredient.list.queryOptions,
      buildFilters: (ts) => ({
        nameFilter: ts.getColumnFilter("name"),
        missingProductsOnly: globalFilter.missingProductsOnly,
      }),
      getMappings: getIngredientMappings,
      columns,
      filters: [{ id: "name", placeholder: "Filter by ingredient name..." }],
      globalFilter,
      onGlobalFilterChange: setGlobalFilter as (value: unknown) => void,
      bulkActions: {
        actions: [
          {
            id: "merge",
            label: "Merge",
            icon: <Merge className="h-4 w-4" />,
            minSelection: 2,
            requiresConfirmation: true,
            renderConfirmation: (rows) => {
              const target = rows[0]?.original;
              const aliases = rows.slice(1).map((r) => r.original);
              return (
                <div className="space-y-3">
                  <div>
                    <div className="mb-1 font-medium text-muted-foreground text-sm">
                      Keep (target):
                    </div>
                    {target && (
                      <EntityPillLink
                        entity="ingredient"
                        data={{ name: target.name, id: target.id }}
                      />
                    )}
                  </div>
                  <div>
                    <div className="mb-1 font-medium text-muted-foreground text-sm">
                      Merge into aliases:
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {aliases.map((a) => (
                        <EntityPillLink
                          key={a.id}
                          entity="ingredient"
                          data={{ name: a.name, id: a.id }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              );
            },
            onExecute: async (rows) => {
              const [target, ...aliasRows] = rows.map((r) => r.original);
              if (!target) return { success: false };
              await trpcClient.ingredient.merge.mutate({
                target: target.id,
                aliases: aliasRows.map((a) => a.id),
              });
              toast.success(
                `Merged into ${target.name} (${aliasRows.length} ingredient${aliasRows.length === 1 ? "" : "s"})`,
              );
              return { success: true };
            },
          },
        ],
      },
      deletable: deletableConfig,
    });

  return (
    <div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Ingredients Table"
        timing={timing}
        entity="ingredient"
        onRowClick={onRowClick}
        bulkActionBar={bulkActionBar}
        actions={
          <Button
            variant="default"
            render={<Link to="/ingredients/new" />}
            nativeButton={false}
          >
            Create New Ingredient
          </Button>
        }
        additionalToolbarContent={
          <div className="flex items-center space-x-2">
            <Checkbox
              id={missingProductsId}
              checked={table.getState().globalFilter.missingProductsOnly}
              onCheckedChange={(checked) =>
                table.setGlobalFilter({ missingProductsOnly: checked })
              }
            />
            <label
              htmlFor={missingProductsId}
              className="font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Missing Products Only
            </label>
          </div>
        }
      />
      <PreviewSheet />
      {deleteDialog}
    </div>
  );
}
