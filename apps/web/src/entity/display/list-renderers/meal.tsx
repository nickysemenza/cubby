import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";

import type { ListRenderer, ListRowOf } from "../list-renderer-types";

const recipeLinks: ListRenderer<"meal"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor(
        (row) =>
          row.recipes.map((recipe) => ({
            id: recipe.recipeId,
            name: recipe.recipe.name,
          })),
        {
          id: "recipes",
          header: "Recipes",
          enableSorting: false,
          meta: attachCubbyColumnMeta<ListRowOf<"meal">>({
            className: "min-w-0 w-56 overflow-hidden",
            mobile: { slot: "meta", priority: 20 },
            entityRefs: (row) =>
              row.recipes.map((recipe) => ({
                entityKind: "recipe",
                entityId: recipe.recipeId,
              })),
          }),
          cell: (info) => (
            <EntityRefLink
              variant="list"
              entity="recipe"
              items={info.getValue()}
              compact
              maxItems={3}
              resolveImages={false}
            />
          ),
        },
      ),
    );
  });

export const mealListRenderers = {
  "recipe-links": recipeLinks,
} as const;
