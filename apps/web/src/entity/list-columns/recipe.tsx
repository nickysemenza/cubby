import type { RecipeListItem } from "@cubby/schemas/recipe";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import type { EntityListParamsByEntity } from "~/entity/generated/entity-lists.gen";
import { EditableTagsCell } from "~/features/recipes/editable-tags-cell";
import { RecipeTag } from "~/features/recipes/recipe-tag";
import { formatYield } from "~/features/recipes/recipe-utils";
import { relatedData } from "~/integrations/tanstack-query/generated/catalog.gen";
import { countLabel } from "~/lib/pluralize";
import {
  numberCellData,
  specFromCellData,
  tagsCellData,
} from "~/ui/data-table/cell-data";
import { EditableCell } from "~/ui/data-table/editable-cell";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useDeletableConfig } from "~/ui/hooks/useDeletableConfig";
import { useTagOptions } from "~/ui/hooks/useEntityOptions";
import { useFilterOptions } from "~/ui/hooks/useFilterOptions";
import { useUpdateMutation } from "~/ui/hooks/useUpdateMutation";
import type { FilterableComboboxItem } from "~/ui/primitives/combobox";
import { NoneValue } from "~/ui/primitives/none-value";
import { TruncatedList } from "~/ui/TruncatedList";

import { defineListOverride } from "./types";

type RecipeFilters = EntityListParamsByEntity["recipe"]["filters"];

const columnHelper = createCubbyColumnHelper<RecipeListItem>();
const NO_INGREDIENT_OPTIONS: FilterableComboboxItem[] = [];

export const recipeListOverride = defineListOverride<
  RecipeListItem,
  RecipeFilters
>({
  use() {
    const { options: tagOptions } = useTagOptions("recipe");
    const ingredientOptionsQuery = useQuery(
      relatedData.options.queryOptions({
        relationKey: "recipe.ingredients",
        limit: 100,
      }),
    );
    const ingredientOptions = useMemo<FilterableComboboxItem[]>(
      () =>
        ingredientOptionsQuery.data?.map(({ id, label, count }) => ({
          value: id,
          label,
          hint: String(count),
        })) ?? NO_INGREDIENT_OPTIONS,
      [ingredientOptionsQuery.data],
    );
    const filterOptions = useFilterOptions({
      tags: tagOptions,
      recipeIngredients: ingredientOptions,
    });

    const updateRecipeMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("recipe", "update"),
      entity: "recipe",
    });
    // Its own config, not the contract default: a recipe write from this
    // table only moves `recipe.list`, not the meal rollups.
    const deletable = useDeletableConfig({
      mutationFn: entityMutationOptionsFactory("recipe", "delete"),
      entityLabel: "Recipe",
      entity: "recipe",
    });

    const overrides = useMemo(() => {
      // The cellData drives both the range copy/paste engine and the
      // focused-cell clipboard — one source of truth for tag save semantics.
      const saveTags = async (
        row: RecipeListItem,
        nextTags: string[] | null,
      ) => {
        await updateRecipeMutation.mutateAsync({
          id: row.id,
          data: { tags: nextTags },
        });
      };
      const tagsCellDataDef = tagsCellData<RecipeListItem>(
        (row) => row.tags ?? null,
        saveTags,
      );
      // Yield falls back to inline-editable `servings` only when the recipe
      // has no structured yield; copy/paste is available on exactly those rows.
      const saveServings = async (
        row: RecipeListItem,
        value: number | null,
      ) => {
        if (row.yield) {
          throw new Error(
            "This recipe has a structured yield — edit servings on its detail page.",
          );
        }
        await updateRecipeMutation.mutateAsync({
          id: row.id,
          data: { servings: value === null ? null : Math.round(value) },
        });
      };
      const servingsCellDataDef = numberCellData<RecipeListItem>(
        "number",
        (row) => (row.yield ? null : (row.servings ?? null)),
        saveServings,
      );
      const renderTags = (tags: string[] | null) => {
        if (!tags?.length) return <NoneValue />;
        return (
          <TruncatedList
            items={tags}
            maxItems={2}
            renderItem={(tag) => <RecipeTag key={tag} tag={tag} size="sm" />}
          />
        );
      };
      return createCubbyColumnCollection<RecipeListItem>((add) => {
        add(
          columnHelper.accessor("tags", {
            id: "tags",
            header: "Tags",
            enableSorting: true,
            meta: attachCubbyColumnMeta({
              className: "w-48",
              mobile: { slot: "subtitle", priority: 10 },
              cellData: tagsCellDataDef,
            }),
            cell: (info) => {
              const recipe = info.row.original;
              return (
                <EditableTagsCell
                  value={recipe.tags ?? null}
                  renderValue={renderTags}
                  clipboard={specFromCellData(tagsCellDataDef, recipe)}
                  onSave={(nextTags) => saveTags(recipe, nextTags)}
                />
              );
            },
          }),
        );
        // Accessor (not display) so it sorts server-side on `servings`.
        add(
          columnHelper.accessor((row) => row.servings ?? undefined, {
            id: "servings",
            meta: attachCubbyColumnMeta({
              numeric: true,
              className: "w-24",
              mobile: { slot: "trailing", priority: 5, interactive: true },
              cellData: servingsCellDataDef,
            }),
            cell: (info) => {
              const recipe = info.row.original;
              // A structured yield is owned by the detail page's editor.
              if (recipe.yield) return formatYield(recipe.yield);
              return (
                <EditableCell
                  value={recipe.servings ?? null}
                  config={{ type: "number" }}
                  clipboard={specFromCellData(servingsCellDataDef, recipe)}
                  renderValue={(servings) =>
                    servings == null ? (
                      <NoneValue />
                    ) : (
                      countLabel(servings, "serving")
                    )
                  }
                  onSave={(newValue) => saveServings(recipe, newValue)}
                />
              );
            },
          }),
        );
      });
      // oxlint-disable-next-line react/exhaustive-deps -- updateRecipeMutation changes every render but is functionally stable
    }, []);

    const list = useMemo(
      () => ({
        deletable,
        filterOptions,
      }),
      [deletable, filterOptions],
    );
    return { overrides, list };
  },
});
