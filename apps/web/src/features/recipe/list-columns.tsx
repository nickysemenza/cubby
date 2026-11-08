import { fieldValueOf } from "@cubby/schemas/field-envelope";

import type { ListRowOf } from "~/entity/display/list-renderer-types";
type RecipeListItem = ListRowOf<"recipe">;
import { countLabel } from "@cubby/shared/pluralize";
import { useMemo } from "react";

import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { useUpdateMutation } from "~/entity/hooks/use-update-mutation";
import type { EntityListParamsByEntity } from "~/entity/model/list-contracts";
import { formatYield } from "~/entity/presentation/recipe-yield";
import { EditableCell } from "~/entity/table/editable-cell";
import { EditableTagsCell } from "~/features/recipe/editable-tags-cell";
import { RecipeTag } from "~/features/recipe/recipe-tag";
import {
  numberCellData,
  specFromCellData,
  tagsCellData,
} from "~/ui/data-table/cell-data";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { NoneValue } from "~/ui/text/none-value";
import { TruncatedList } from "~/ui/text/truncated-list";

import { defineListOverride } from "../../entity/list-columns/types";

type RecipeFilters = EntityListParamsByEntity["recipe"]["filters"];

const columnHelper = createCubbyColumnHelper<RecipeListItem>();

export const recipeListOverride = defineListOverride<
  RecipeListItem,
  RecipeFilters
>({
  use() {
    const updateRecipeMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("recipe", "update"),
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
      const tagsCellDataDef = tagsCellData<RecipeListItem>((row) => {
        const effectiveRowTags = fieldValueOf(row.fields.tags);
        return effectiveRowTags ?? null;
      }, saveTags);
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
        (row) => {
          const effectiveRowServings = fieldValueOf(row.fields.servings);
          return row.yield ? null : (effectiveRowServings ?? null);
        },
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
          columnHelper.accessor((row) => fieldValueOf(row.fields.tags) ?? [], {
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
                  value={fieldValueOf(recipe.fields.tags) ?? null}
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
          columnHelper.accessor(
            (row) => {
              const effectiveRowServings = fieldValueOf(row.fields.servings);
              return effectiveRowServings ?? undefined;
            },
            {
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
                    value={fieldValueOf(recipe.fields.servings)}
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
            },
          ),
        );
      });
      // oxlint-disable-next-line react/exhaustive-deps -- updateRecipeMutation changes every render but is functionally stable
    }, []);

    const list = useMemo(
      () => ({
        deletable: true as const,
      }),
      [],
    );
    return { overrides, list };
  },
});
