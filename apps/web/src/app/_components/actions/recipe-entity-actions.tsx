import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useDuplicateRecipe } from "../recipe/use-duplicate-recipe";
import { VerbMenuItem } from "./action-verb-ui";
import { defineEntityAction } from "./entity-action-definition";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";

/**
 * Recipe actions that do not need the list's filter or cookbook scope.
 *
 * The definitions deliberately live beside their hooks instead of in the
 * central registry: this makes the recipe-specific navigation and mutation
 * ownership explicit, while the registry only decides which surfaces resolve
 * them.
 */
function useDuplicateRecipeEntityAction(): EntityActionHandles {
  const { duplicateRecipe, isPending } = useDuplicateRecipe();

  const run = useCallback(
    async (rows: readonly EntityActionRow[]) => {
      const row = rows[0];
      if (!row) return { success: false };
      duplicateRecipe(row.id);
      return { success: true };
    },
    [duplicateRecipe],
  );

  return {
    run,
    rowMenuItem: (row) => (
      <VerbMenuItem
        key="duplicate"
        verb="duplicate"
        disabled={isPending}
        onSelect={() => duplicateRecipe(row.id)}
      />
    ),
    dialog: null,
    availability: () =>
      isPending
        ? {
            status: "disabled",
            reason: "A recipe is already being duplicated.",
          }
        : { status: "available" },
  };
}

function useCompareRecipesEntityAction(): EntityActionHandles {
  const navigate = useNavigate();
  const run = useCallback(
    async (rows: readonly EntityActionRow[]) => {
      if (rows.length < 2) return { success: false };
      navigate({
        to: "/recipes/compare",
        search: { ids: rows.map((row) => row.id).join(",") },
      });
      return { success: true };
    },
    [navigate],
  );

  return { run, rowMenuItem: () => null, dialog: null };
}

export const recipeEntityActionDefinitions = [
  defineEntityAction({
    verb: "duplicate",
    entities: ["recipe"],
    arity: "single",
    surfaces: ["row", "inspector", "detail"],
    group: "primary",
    priority: 100,
    use: useDuplicateRecipeEntityAction,
  }),
  defineEntityAction({
    verb: "compare",
    entities: ["recipe"],
    arity: "multi",
    surfaces: ["selection"],
    group: "organize",
    priority: 100,
    preserveSelection: true,
    use: useCompareRecipesEntityAction,
  }),
] as const;
