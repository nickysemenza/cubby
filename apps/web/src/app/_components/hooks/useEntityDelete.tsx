import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { PreviewDeleteEntity } from "@cubby/schemas/entity-integrity";
import type { QueryKey } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash } from "lucide-react";
import { type ReactElement, useCallback, useMemo, useState } from "react";
import {
  OperationImpact,
  useOperationPreview,
} from "~/app/_components/impact/operation-impact";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { Button } from "~/components/ui/button";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { type MutationOptionsFn, useActionMutation } from "./useActionMutation";

const emptySideEffects: MutationSideEffects = { backgroundBatches: [] };

interface UseEntityDeleteOptions {
  /** Entity ID */
  id: string;
  /** Entity name for dialog display */
  name: string;
  /** Entity type label for dialog (e.g., "Product", "Ingredient") */
  entityLabel: string;
  /** Entity slug for the operation-impact preview fetched while the confirm dialog is open. */
  entity: PreviewDeleteEntity;
  /** tRPC delete mutation options factory */
  mutationOptions: (callbacks: {
    onSuccess: (data: { sideEffects?: MutationSideEffects }) => void;
    onError: (err: { message?: string }) => void;
  }) => unknown;
  /** Query keys to invalidate on success */
  invalidateKeys: readonly QueryKey[];
  /** Route to navigate to after deletion */
  redirectTo: string;
  /**
   * Overrides the dialog's body copy. Pass this when the delete cascades to
   * things the row itself doesn't show — a task's subtasks and dependency
   * edges, say — since the generic sentence gives no hint that they go too.
   */
  description?: string;
}

interface UseEntityDeleteReturn {
  /** Opens the delete confirmation dialog */
  openDeleteDialog: () => void;
  /**
   * Pre-configured destructive delete button — an ELEMENT, not a component.
   * Declaring these as components inside the hook body gave React a new
   * element *type* every render, so it tore down and rebuilt the subtree —
   * including this dialog while it was open mid-confirm. Same shape as
   * `useOptimisticDelete`'s `deleteDialog`.
   */
  deleteButton: ReactElement;
  /** Delete dialog (must be rendered) */
  deleteDialog: ReactElement;
  /** Whether delete is in progress */
  isPending: boolean;
}

/**
 * Hook for managing entity deletion from detail pages.
 * Provides a delete button, confirmation dialog, and handles
 * mutation, cache invalidation, and navigation.
 */
export function useEntityDelete({
  id,
  name,
  entityLabel,
  entity,
  mutationOptions,
  invalidateKeys,
  redirectTo,
  description,
}: UseEntityDeleteOptions): UseEntityDeleteReturn {
  const navigate = useNavigate();
  const [showDialog, setShowDialog] = useState(false);

  // Impact preview — fetched only while the dialog is open, always fresh for
  // this id. See `useOperationPreview`'s doc comment for the gating rule.
  const previewInput = useMemo(
    () => ({ operation: "delete" as const, entity, ids: [id] }),
    [entity, id],
  );
  const preview = useOperationPreview(previewInput, showDialog);

  // `mutationOptions`'s narrower callback shape isn't literally the
  // `MutationOptionsFn` signature `useActionMutation` is generic over (its
  // callbacks carry the delete-specific `{ sideEffects }` result), but it's
  // the same tRPC `*.delete.mutationOptions` factory shape every call site
  // passes — invalidation, background-batch re-invalidation, and the error
  // toast all now come from `useActionMutation` itself.
  const deleteMutation = useActionMutation({
    mutationFn: mutationOptions as unknown as MutationOptionsFn,
    invalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        (data as { sideEffects?: MutationSideEffects }).sideEffects ??
          emptySideEffects,
        `${entityLabel} deleted`,
      ),
    onSuccess: () => {
      void navigate({ to: redirectTo });
    },
    error: (err) =>
      getErrorMessage(err) || `Failed to delete ${entityLabel.toLowerCase()}`,
  });

  const openDeleteDialog = useCallback(() => {
    setShowDialog(true);
  }, []);

  const deleteButton = useMemo(
    () => (
      <Button variant="destructive" size="sm" onClick={openDeleteDialog}>
        <Trash />
        Delete
      </Button>
    ),
    [openDeleteDialog],
  );

  // Depend on `isPending`/`mutateAsync`, never the whole mutation object:
  // react-query returns a new result object every render, which would make
  // this memo a no-op. `mutateAsync` is bound once by the MutationObserver.
  const deleteDialog = useMemo(
    () => (
      <BulkActionDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        items={[{ id, name }]}
        itemNoun={entityLabel}
        action="Delete"
        variant="destructive"
        pendingLabel="Deleting..."
        description={
          description ??
          `This will permanently remove ${entityLabel.toLowerCase()} from your workspace. This action cannot be undone.`
        }
        renderItem={(item) => item.name}
        onSubmit={async () => {
          await deleteMutation.mutateAsync({ ids: [id] });
          setShowDialog(false);
        }}
        isPending={deleteMutation.isPending}
        blocked={preview.data?.canProceed === false}
      >
        <OperationImpact
          preview={preview.data}
          isLoading={preview.isLoading}
          isError={preview.isError}
          onRetry={() => void preview.refetch()}
        />
      </BulkActionDialog>
    ),
    // Not `preview` wholesale — react-query hands back a new result object
    // every render; only the scalar fields are read.
    [
      showDialog,
      id,
      name,
      entityLabel,
      description,
      deleteMutation.isPending,
      deleteMutation.mutateAsync,
      preview.data,
      preview.isLoading,
      preview.isError,
      preview.refetch,
    ],
  );

  return {
    openDeleteDialog,
    deleteButton,
    deleteDialog,
    isPending: deleteMutation.isPending,
  };
}
