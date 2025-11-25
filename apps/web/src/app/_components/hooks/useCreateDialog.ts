"use client";

import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getErrorMessage } from "~/lib/error-utils";

export interface UseCreateDialogOptions<TEntity> {
  entityName: string; // e.g., "ingredient", "product"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mutationOptions: any; // tRPC mutation options
  queryKey?: string[]; // Query key to invalidate on success
  onSuccess?: (entity: TEntity) => void;
}

export interface UseCreateDialogReturn<TEntity, TInput> {
  isOpen: boolean;
  open: (initialData?: Partial<TInput>) => Promise<TEntity>;
  close: () => void;
  handleCreate: (data: TInput) => void;
  handleCancel: () => void;
  isPending: boolean;
  error: string | undefined;
  initialData: Partial<TInput> | undefined;
}

/**
 * Hook for managing create dialogs with Promise-based resolution.
 *
 * Handles:
 * - Dialog state management
 * - Promise-based dialog resolution (useful for comboboxes)
 * - Create mutation with success/error callbacks
 * - Query invalidation on success
 * - Toast notifications
 *
 * @example
 * ```tsx
 * const createDialog = useCreateDialog({
 *   entityName: "ingredient",
 *   mutationOptions: api.ingredient.create.mutationOptions(),
 *   queryKey: ["ingredient", "list"],
 * });
 *
 * // Programmatic usage (for comboboxes)
 * const onCreateNew = async (name: string) => {
 *   return await createDialog.open({ name });
 * };
 *
 * return (
 *   <>
 *     <CreateIngredientDialog
 *       isOpen={createDialog.isOpen}
 *       onOpenChange={(open) => !open && createDialog.close()}
 *       onCancel={createDialog.handleCancel}
 *       onCreate={createDialog.handleCreate}
 *       isPending={createDialog.isPending}
 *       error={createDialog.error}
 *       initialData={createDialog.initialData}
 *     />
 *     {children({ onCreateNew })}
 *   </>
 * );
 * ```
 */
export function useCreateDialog<TEntity, TInput>({
  entityName,
  mutationOptions,
  queryKey,
  onSuccess,
}: UseCreateDialogOptions<TEntity>): UseCreateDialogReturn<TEntity, TInput> {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [initialData, setInitialData] = useState<Partial<TInput> | undefined>();
  const [pendingResolve, setPendingResolve] = useState<
    ((value: TEntity) => void) | null
  >(null);

  const mutation = useMutation<TEntity, unknown, TInput>({
    ...mutationOptions,
    onSuccess: (newEntity: TEntity) => {
      toast.success(
        `Created new ${entityName}: ${(newEntity as { name?: string }).name ?? entityName}`,
      );

      // Invalidate queries if key provided
      if (queryKey) {
        queryClient.invalidateQueries({ queryKey });
      }

      setIsOpen(false);
      setInitialData(undefined);

      // Call custom success callback
      onSuccess?.(newEntity);

      // Resolve promise if waiting
      if (pendingResolve) {
        pendingResolve(newEntity);
        setPendingResolve(null);
      }
    },
    onError: (error: unknown) => {
      toast.error(`Failed to create ${entityName}: ${getErrorMessage(error)}`);
    },
  });

  const open = useCallback((data?: Partial<TInput>): Promise<TEntity> => {
    setInitialData(data);
    setIsOpen(true);
    return new Promise<TEntity>((resolve) => {
      setPendingResolve(() => resolve);
    });
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setInitialData(undefined);
    setPendingResolve(null);
  }, []);

  const handleCreate = useCallback(
    (data: TInput) => {
      mutation.mutate(data);
    },
    [mutation],
  );

  const handleCancel = useCallback(() => {
    close();
  }, [close]);

  return {
    isOpen,
    open,
    close,
    handleCreate,
    handleCancel,
    isPending: mutation.isPending,
    error: mutation.error ? getErrorMessage(mutation.error) : undefined,
    initialData,
  };
}
