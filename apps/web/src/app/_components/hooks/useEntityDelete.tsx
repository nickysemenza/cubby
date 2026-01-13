import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash } from "lucide-react";
import { type FC, useCallback, useState } from "react";
import { toast } from "sonner";
import { DeleteEntityDialog } from "~/components/dialogs/delete-entity-dialog";
import { Button } from "~/components/ui/button";

interface UseEntityDeleteOptions {
  /** Entity ID */
  id: string;
  /** Entity name for dialog display */
  name: string;
  /** Entity type label for dialog (e.g., "Product", "Ingredient") */
  entityLabel: string;
  /** tRPC delete mutation options factory */
  mutationOptions: (callbacks: {
    onSuccess: () => void;
    onError: (err: { message?: string }) => void;
  }) => unknown;
  /** Query keys to invalidate on success */
  invalidateKeys: readonly unknown[][];
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
 *
 * @example
 * ```tsx
 * const { DeleteButton, DeleteDialog } = useEntityDelete({
 *   id: product.id,
 *   name: product.name,
 *   entityLabel: "Product",
 *   mutationOptions: (callbacks) => api.product.delete.mutationOptions(callbacks),
 *   invalidateKeys: [queryKeys.product.list],
 *   redirectTo: "/products",
 * });
 *
 * return (
 *   <>
 *     <BasicInfo actions={<DeleteButton />} />
 *     <DeleteDialog />
 *   </>
 * );
 * ```
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
  const navigate = useNavigate();
  const [showDialog, setShowDialog] = useState(false);

  const deleteMutation = useMutation(
    mutationOptions({
      onSuccess: () => {
        toast.success(`${entityLabel} deleted`);
        for (const key of invalidateKeys) {
          // Wrap key in array to match tRPC's nested structure: [["entity", "list"], {...}]
          void queryClient.invalidateQueries({ queryKey: [key as unknown[]] });
        }
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
    <DeleteEntityDialog
      open={showDialog}
      onOpenChange={setShowDialog}
      items={[{ id, name }]}
      entityType={entityLabel}
      onDelete={async () => {
        await deleteMutation.mutateAsync({ ids: [id] });
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
