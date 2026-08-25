import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { useState } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { recipeDeleteCookbookMutationOptions } from "~/app/recipes/recipe.functions";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidatesFor } from "~/lib/query-keys";

/** The minimal identity `requestDelete` needs — either grid row or detail-page state. */
export interface CookbookDeleteTarget {
  id: CookbookShortcode;
  name: string;
  /** Undefined while the summary hasn't loaded yet (detail page's first paint). */
  recipeCount?: number;
}

/**
 * Shared `deleteCookbook` confirm flow for the cookbook grid AND the cookbook
 * detail page, so the cascade copy can't drift between the two surfaces.
 *
 * `deleteCookbook` is UNGUARDED: it soft-deletes every recipe imported from the
 * book — including ones used as a sub-recipe elsewhere or currently planned
 * into a meal — plus their sections/ingredients/images/embeddings, then the
 * Cookbook row itself. The confirm copy says so; there is no separate warning
 * at delete time for those cross-references.
 */
export function useCookbookDelete({
  onDeleted,
}: {
  onDeleted?: () => void;
} = {}) {
  const [pendingDelete, setPendingDelete] =
    useState<CookbookDeleteTarget | null>(null);

  const deleteMutation = useActionMutation({
    mutationFn: recipeDeleteCookbookMutationOptions,
    success: ({ deletedRecipes }) =>
      `Deleted ${pendingDelete?.name ?? "cookbook"} and ${deletedRecipes} recipe${deletedRecipes === 1 ? "" : "s"}`,
    invalidateKeys: invalidatesFor("recipe", "cookbook"),
    onSuccess: () => {
      setPendingDelete(null);
      onDeleted?.();
    },
    error: (err) => getErrorMessage(err) || "Failed to delete cookbook",
  });

  const dialog = pendingDelete && (
    <BulkActionDialog
      open
      onOpenChange={(open) => {
        if (!open) setPendingDelete(null);
      }}
      items={[{ id: pendingDelete.id, name: pendingDelete.name }]}
      itemNoun="cookbook"
      action="Delete"
      variant="destructive"
      pendingLabel="Deleting..."
      description="Deleting this cookbook also deletes every recipe it produced — including ones used as a sub-recipe elsewhere or currently planned into a meal, with no separate warning. This cannot be undone."
      onSubmit={async () => {
        await deleteMutation.mutateAsync({ cookbookId: pendingDelete.id });
      }}
      isPending={deleteMutation.isPending}
      renderItem={() =>
        pendingDelete.recipeCount === undefined
          ? `"${pendingDelete.name}" and its imported recipes`
          : `"${pendingDelete.name}" and its ${pendingDelete.recipeCount} imported recipe${pendingDelete.recipeCount === 1 ? "" : "s"}`
      }
    />
  );

  return {
    requestDelete: (cookbook: CookbookDeleteTarget) =>
      setPendingDelete(cookbook),
    dialog,
  };
}
