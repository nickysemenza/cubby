import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { Entity } from "@cubby/schemas/entity";
import type { QueryKey } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash } from "lucide-react";
import { type ReactElement, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { Button } from "~/components/ui/button";
import type { EditableEntity } from "~/entities/editing/types";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import { entityDialogLabel } from "~/entities/entities";
import { getEntityContract } from "~/entities/entity-contracts";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { type MutationOptionsFn, useActionMutation } from "./useActionMutation";

const emptySideEffects: MutationSideEffects = { backgroundBatches: [] };

interface UseEntityDeleteOptions {
  /** Entity ID */
  id: string;
  /** Entity name for dialog display */
  name: string;
  /** Dialog noun override; defaults to the entity registry. */
  entityLabel?: string;
  /** Entity slug — picks the registered-command delete path vs the legacy mutation. */
  entity: Entity;
  /** tRPC delete mutation options factory */
  mutationOptions: (callbacks: {
    onSuccess: (data: { sideEffects?: MutationSideEffects }) => void;
    onError: (err: { message?: string }) => void;
  }) => unknown;
  /**
   * Override the fan-out invalidated on success. Omit it — the default is the
   * entity's own `invalidatesFor(entity)` set, resolved through its contract.
   */
  invalidateKeys?: readonly QueryKey[];
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
  openDeleteDialog: () => void;
  /**
   * Pre-configured destructive delete button — an ELEMENT, not a component.
   * Declaring these as components inside the hook body gave React a new
   * element *type* every render, so it tore down and rebuilt the subtree —
   * including this dialog while it was open mid-confirm. Same shape as
   * `useOptimisticDelete`'s `deleteDialog`.
   */
  deleteButton: ReactElement;
  deleteDialog: ReactElement;
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
  const label = entityLabel ?? entityDialogLabel(entity);
  const navigate = useNavigate();
  const [showDialog, setShowDialog] = useState(false);
  const registeredDelete = entity !== "image" && entity !== "cookbook";
  // Image/cookbook have non-standard lifecycle contracts and keep their
  // specialized path; every standard entity dispatches through the registry.
  const commandEntity = (
    registeredDelete ? entity : "product"
  ) as EditableEntity;
  const commands = useEntityCommands(commandEntity);

  // `mutationOptions`'s narrower callback shape isn't literally the
  // `MutationOptionsFn` signature `useActionMutation` is generic over (its
  // callbacks carry the delete-specific `{ sideEffects }` result), but it's
  // the same transport-neutral mutation-options factory shape every call site
  // passes — invalidation, background-batch re-invalidation, and the error
  // toast all now come from `useActionMutation` itself.
  const legacyDeleteMutation = useActionMutation({
    mutationFn: mutationOptions as unknown as MutationOptionsFn,
    invalidateKeys:
      invalidateKeys ?? getEntityContract(entity).invalidationKeys,
    success: (data) =>
      savedWithBackgroundWork(
        (data as { sideEffects?: MutationSideEffects }).sideEffects ??
          emptySideEffects,
        `${label} deleted`,
      ),
    onSuccess: () => {
      void navigate({ to: redirectTo });
    },
    error: (err) =>
      getErrorMessage(err) || `Failed to delete ${label.toLowerCase()}`,
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
        itemNoun={label}
        action="Delete"
        variant="destructive"
        pendingLabel="Deleting..."
        description={
          description ??
          `This will permanently remove ${label.toLowerCase()} from your workspace. This action cannot be undone.`
        }
        renderItem={(item) => item.name}
        onSubmit={async () => {
          if (registeredDelete) {
            const execution = await commands.remove([id]);
            if (!execution.ok) {
              throw new Error(
                execution.issues[0]?.message ?? `Failed to delete ${label}`,
              );
            }
            toast.success(
              savedWithBackgroundWork(
                (
                  execution.result as {
                    sideEffects?: MutationSideEffects;
                  }
                ).sideEffects ?? emptySideEffects,
                `${label} deleted`,
              ),
            );
            void navigate({ to: redirectTo });
          } else {
            await legacyDeleteMutation.mutateAsync({ ids: [id] });
          }
          setShowDialog(false);
        }}
        isPending={
          registeredDelete ? commands.isPending : legacyDeleteMutation.isPending
        }
      />
    ),
    [
      showDialog,
      id,
      name,
      label,
      description,
      registeredDelete,
      commands.remove,
      commands.isPending,
      legacyDeleteMutation.isPending,
      legacyDeleteMutation.mutateAsync,
      navigate,
      redirectTo,
    ],
  );

  return {
    openDeleteDialog,
    deleteButton,
    deleteDialog,
    isPending: registeredDelete
      ? commands.isPending
      : legacyDeleteMutation.isPending,
  };
}
