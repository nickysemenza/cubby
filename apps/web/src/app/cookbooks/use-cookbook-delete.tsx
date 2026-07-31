import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { useMemo, useState } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import {
  OperationImpact,
  useOperationPreview,
} from "~/app/_components/impact/operation-impact";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { recipeCookbookMutationInvalidateKeys } from "~/lib/query-keys";

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
  const api = useTRPC();
  const [pendingDelete, setPendingDelete] =
    useState<CookbookDeleteTarget | null>(null);

  const deleteMutation = useActionMutation({
    mutationFn: api.recipe.deleteCookbook.mutationOptions,
    success: ({ deletedRecipes }) =>
      `Deleted ${pendingDelete?.name ?? "cookbook"} and ${deletedRecipes} recipe${deletedRecipes === 1 ? "" : "s"}`,
    invalidateKeys: recipeCookbookMutationInvalidateKeys,
    onSuccess: () => {
      setPendingDelete(null);
      onDeleted?.();
    },
    error: (err) => getErrorMessage(err) || "Failed to delete cookbook",
  });

  // Impact preview — fetched only while the dialog is open. Replaces the old
  // static cascade prose (recipe/section/ingredient counts) with live counts;
  // see `useOperationPreview`'s doc comment for the gating rule.
  const previewInput = useMemo(
    () =>
      pendingDelete
        ? {
            operation: "delete" as const,
            entity: "cookbook" as const,
            ids: [pendingDelete.id],
          }
        : null,
    [pendingDelete],
  );
  const preview = useOperationPreview(previewInput, pendingDelete !== null);

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
      // The count-able cascade (recipes/sections/ingredients) now comes from
      // the live preview below — this is only the part a count can't say.
      description="Recipes used as a sub-recipe elsewhere or currently planned into a meal are deleted too, with no separate warning. This cannot be undone."
      onSubmit={async () => {
        await deleteMutation.mutateAsync({ cookbookId: pendingDelete.id });
      }}
      isPending={deleteMutation.isPending}
      blocked={preview.data?.canProceed === false}
      renderItem={() =>
        pendingDelete.recipeCount === undefined
          ? `"${pendingDelete.name}" and its imported recipes`
          : `"${pendingDelete.name}" and its ${pendingDelete.recipeCount} imported recipe${pendingDelete.recipeCount === 1 ? "" : "s"}`
      }
    >
      <OperationImpact
        preview={preview.data}
        isLoading={preview.isLoading}
        isError={preview.isError}
        onRetry={() => void preview.refetch()}
      />
    </BulkActionDialog>
  );

  return {
    requestDelete: (cookbook: CookbookDeleteTarget) =>
      setPendingDelete(cookbook),
    dialog,
  };
}
