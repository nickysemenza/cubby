import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DeleteEntityDialog } from "~/components/dialogs/delete-entity-dialog";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "~/components/ui/dropdown-menu";
import type { BulkAction } from "../data-table/bulk-actions.types";

interface DeletableConfig {
  /** tRPC delete mutation options factory */
  mutationOptions: (callbacks: {
    onSuccess: () => void;
    onError: (err: { message?: string }) => void;
  }) => unknown;
  /** Entity type label for dialog (e.g., "Product", "Ingredient") */
  entityLabel: string;
  /** Query keys to invalidate on success */
  invalidateKeys: readonly unknown[][];
}

interface UseOptimisticDeleteOptions<TData extends { id: string }> {
  /** Delete configuration (null to disable) */
  deletable: DeletableConfig | undefined;
  /** Extra actions to render in the row action menu */
  extraActions?: (row: TData) => ReactNode;
}

interface UseOptimisticDeleteReturn<TData> {
  /** Bulk action for delete (to merge into bulk actions config) */
  deleteBulkAction: BulkAction<TData> | null;
  /** Combined extra actions renderer (includes delete menu item) */
  combinedExtraActions: ((row: TData) => ReactNode) | undefined;
  /** Delete dialog element - render in component */
  deleteDialog: ReactNode | null;
}

/**
 * Hook for optimistic delete with cache rollback.
 *
 * Handles:
 * - Optimistic removal from query cache
 * - Rollback on error
 * - Delete bulk action
 * - Delete menu item in row actions
 * - Delete confirmation dialog
 */
export function useOptimisticDelete<
  TData extends { id: string; name?: string },
>({
  deletable,
  extraActions,
}: UseOptimisticDeleteOptions<TData>): UseOptimisticDeleteReturn<TData> {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<TData | null>(null);

  // Memoize the mutation options to prevent infinite re-renders
  const deleteMutationOptions = useMemo(() => {
    if (!deletable) return null;

    // Get base mutation options from tRPC
    const baseMutationOptions = deletable.mutationOptions({
      onSuccess: () => {
        toast.success(`${deletable.entityLabel} deleted`);
        // Refetch to ensure data is in sync with server
        // Wrap keys in array to match tRPC's nested structure: [["entity", "list"], {...}]
        for (const key of deletable.invalidateKeys) {
          void queryClient.invalidateQueries({ queryKey: [key as unknown[]] });
        }
      },
      onError: (err) => {
        toast.error(
          err.message ||
            `Failed to delete ${deletable.entityLabel.toLowerCase()}`,
        );
      },
    }) as Record<string, unknown>;

    // Extend with optimistic updates
    return {
      ...baseMutationOptions,
      onMutate: async (variables: { ids: string[] }) => {
        // Cancel any outgoing refetches to prevent them from overwriting optimistic update
        // Wrap keys in array to match tRPC's nested structure: [["entity", "list"], {...}]
        for (const key of deletable.invalidateKeys) {
          await queryClient.cancelQueries({ queryKey: [key as unknown[]] });
        }

        // Snapshot the previous value for rollback
        const previousData: Array<unknown> = [];
        for (const key of deletable.invalidateKeys) {
          const currentData = queryClient.getQueryData([key as unknown[]]);
          previousData.push(currentData);
        }

        // Optimistically remove deleted items from all relevant queries
        for (const key of deletable.invalidateKeys) {
          queryClient.setQueryData([key as unknown[]], (old: unknown) => {
            if (!old || typeof old !== "object") {
              return old;
            }
            if (
              !("data" in old) ||
              !Array.isArray((old as { data?: unknown }).data)
            ) {
              return old;
            }

            const oldData = old as { data: Array<{ id: string }> };
            const newData = {
              ...oldData,
              data: oldData.data.filter(
                (item) => !variables.ids.includes(item.id),
              ),
            };
            return newData;
          });
        }

        return { previousData };
      },
      onError: (
        err: unknown,
        _variables: unknown,
        context: { previousData?: unknown[] } | undefined,
      ) => {
        // Roll back optimistic update on error
        if (context?.previousData) {
          deletable.invalidateKeys.forEach((key, index) => {
            // Wrap key in array to match tRPC's nested structure
            queryClient.setQueryData(
              [key as unknown[]],
              context.previousData?.[index],
            );
          });
        }
        // Call the base onError from tRPC (cast to avoid type mismatch)
        if (baseMutationOptions.onError) {
          (
            baseMutationOptions.onError as (
              err: unknown,
              variables: unknown,
              context: unknown,
            ) => void
          )(err, _variables, context);
        }
      },
    };
  }, [deletable, queryClient]);

  // Delete mutation (only created if deletable is provided)
  const deleteMutation = deleteMutationOptions
    ? // biome-ignore lint/correctness/useHookAtTopLevel: Conditional use is intentional - config is stable per usage
      useMutation(deleteMutationOptions as Parameters<typeof useMutation>[0])
    : null;

  // Build delete bulk action
  const deleteBulkAction = useMemo((): BulkAction<TData> | null => {
    if (!deletable || !deleteMutation) return null;

    return {
      id: "delete" as const,
      label: "Delete",
      icon: <Trash className="h-4 w-4" />,
      requiresConfirmation: true,
      onExecute: async (selectedRows: { original: TData }[]) => {
        await deleteMutation.mutateAsync({
          ids: selectedRows.map((row) => row.original.id),
        });
        return { success: true };
      },
    };
  }, [deletable, deleteMutation]);

  // Combine user's extra actions with delete action if deletable is provided
  const combinedExtraActions = useMemo(() => {
    if (!deletable && !extraActions) return undefined;

    return (row: TData) => (
      <>
        {extraActions?.(row)}
        {deletable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                setDeleteTarget(row);
              }}
            >
              <Trash className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </>
    );
  }, [deletable, extraActions]);

  // Build delete dialog element
  const deleteDialog = useMemo(
    () =>
      deletable ? (
        <DeleteEntityDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          items={
            deleteTarget
              ? [
                  {
                    id: deleteTarget.id,
                    name: deleteTarget.name ?? deleteTarget.id,
                  },
                ]
              : []
          }
          entityType={deletable.entityLabel}
          onDelete={async () => {
            if (deleteTarget) {
              await deleteMutation!.mutateAsync({ ids: [deleteTarget.id] });
              setDeleteTarget(null);
            }
          }}
          isPending={deleteMutation?.isPending ?? false}
        />
      ) : null,
    [deletable, deleteTarget, deleteMutation],
  );

  return {
    deleteBulkAction,
    combinedExtraActions,
    deleteDialog,
  };
}
