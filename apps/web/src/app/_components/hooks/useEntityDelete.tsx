import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash } from "lucide-react";
import { type FC, useCallback, useState } from "react";
import { toast } from "sonner";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { Button } from "~/components/ui/button";
import { watchBatchesAndInvalidate } from "~/lib/background-batch-polling";
import { invalidateTRPCQueries } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { useTRPC } from "~/trpc/react";

const emptySideEffects: MutationSideEffects = { backgroundBatches: [] };

interface UseEntityDeleteOptions {
  /** Entity ID */
  id: string;
  /** Entity name for dialog display */
  name: string;
  /** Entity type label for dialog (e.g., "Product", "Ingredient") */
  entityLabel: string;
  /** tRPC delete mutation options factory */
  mutationOptions: (callbacks: {
    onSuccess: (data: { sideEffects?: MutationSideEffects }) => void;
    onError: (err: { message?: string }) => void;
  }) => unknown;
  /** Query keys to invalidate on success */
  invalidateKeys: readonly QueryKey[];
  /** Route to navigate to after deletion */
  redirectTo: string;
}

interface UseEntityDeleteReturn {
  /** Opens the delete confirmation dialog */
  openDeleteDialog: () => void;
  /** Pre-configured delete button */
  DeleteButton: FC<{ size?: "sm" | "default" }>;
  /** Delete dialog (must be rendered) */
  DeleteDialog: FC;
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
  mutationOptions,
  invalidateKeys,
  redirectTo,
}: UseEntityDeleteOptions): UseEntityDeleteReturn {
  const queryClient = useQueryClient();
  const api = useTRPC();
  const navigate = useNavigate();
  const [showDialog, setShowDialog] = useState(false);

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
          fetchBatchStatus: (batchId) =>
            queryClient
              .fetchQuery({
                ...api.backgroundJobs.getBatch.queryOptions({ batchId }),
                staleTime: 0,
              })
              .then((batch) => batch.status),
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

  const DeleteButton: FC<{ size?: "sm" | "default" }> = ({ size = "sm" }) => (
    <Button variant="destructive" size={size} onClick={openDeleteDialog}>
      <Trash className="mr-2 h-4 w-4" />
      Delete
    </Button>
  );

  const DeleteDialog: FC = () => (
    <BulkActionDialog
      open={showDialog}
      onOpenChange={setShowDialog}
      items={[{ id, name }]}
      itemNoun={entityLabel}
      action="Delete"
      variant="destructive"
      pendingLabel="Deleting..."
      description={`This will permanently remove ${entityLabel.toLowerCase()} from your workspace. This action cannot be undone.`}
      renderItem={(item) => item.name}
      onSubmit={async () => {
        await deleteMutation.mutateAsync({ ids: [id] });
        setShowDialog(false);
      }}
      isPending={deleteMutation.isPending}
    />
  );

  return {
    openDeleteDialog,
    DeleteButton,
    DeleteDialog,
    isPending: deleteMutation.isPending,
  };
}
