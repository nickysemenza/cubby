import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { PreviewDeleteEntity } from "@cubby/schemas/entity-integrity";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash } from "lucide-react";
import { type ReactElement, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  OperationImpact,
  useOperationPreview,
} from "~/app/_components/impact/operation-impact";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidate,
} from "~/lib/background-batch-polling";
import { invalidateTRPCQueries } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";

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
  const queryClient = useQueryClient();
  const api = useTRPC();
  const navigate = useNavigate();
  const [showDialog, setShowDialog] = useState(false);

  // Impact preview — fetched only while the dialog is open, always fresh for
  // this id. See `useOperationPreview`'s doc comment for the gating rule.
  const previewInput = useMemo(
    () => ({ operation: "delete" as const, entity, ids: [id] }),
    [entity, id],
  );
  const preview = useOperationPreview(previewInput, showDialog);

  const deleteMutation = useMutation(
    mutationOptions({
      onSuccess: (data) => {
        toast.success(
          savedWithBackgroundWork(
            data.sideEffects ?? emptySideEffects,
            `${entityLabel} deleted`,
          ),
        );
        invalidateTRPCQueries(queryClient, invalidateKeys);
        // Re-invalidate once queued background work (e.g. location valuation)
        // drains so the list reflects recomputed values without a reload.
        void watchBatchesAndInvalidate({
          queryClient,
          result: data,
          invalidateKeys,
          fetchBatchStatus: makeBatchStatusFetcher(queryClient, api),
        });
        void navigate({ to: redirectTo });
      },
      onError: (err) => {
        toast.error(
          err.message || `Failed to delete ${entityLabel.toLowerCase()}`,
        );
      },
    }) as Parameters<typeof useMutation>[0],
  );

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
