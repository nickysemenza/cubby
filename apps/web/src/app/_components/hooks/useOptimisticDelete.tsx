import type { PreviewDeleteEntity } from "@cubby/schemas/entity-integrity";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  OperationImpact,
  useOperationPreview,
} from "~/app/_components/impact/operation-impact";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "~/components/ui/dropdown-menu";
import {
  cancelTRPCQueries,
  invalidateTRPCQueries,
  normalizeTRPCQueryKey,
} from "~/lib/query-keys";
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
  invalidateKeys: readonly QueryKey[];
  /** Entity slug for the operation-impact preview fetched while the confirm dialog is open. */
  entity: PreviewDeleteEntity;
}

interface UseOptimisticDeleteOptions<TData extends { id: string }> {
  /** Delete configuration (null to disable) */
  deletable: DeletableConfig | undefined;
  /** Extra actions to render in the row action menu */
  extraActions?: (row: TData) => ReactNode;
  /**
   * How to name a row in the confirm dialog when `row.name` is null/empty.
   * Without it such a row is listed by its raw UUID, which tells the user
   * nothing about what they're about to delete — the same problem
   * `createNameColumn`'s `emptyLabel` solves in the table cell, and it should
   * give the same answer.
   */
  emptyLabel?: (row: TData) => string;
}

interface UseOptimisticDeleteReturn<TData> {
  /** Bulk action for delete (to merge into bulk actions config) */
  deleteBulkAction: BulkAction<TData> | null;
  /** Combined extra actions renderer (includes delete menu item) */
  combinedExtraActions: ((row: TData) => ReactNode) | undefined;
  /** Delete dialog element - render in component */
  deleteDialog: ReactNode | null;
  /** Opens the delete confirmation dialog for one item (e.g. swipe actions) */
  requestDelete: (item: TData) => void;
}

type CachedList = {
  items?: Array<{ id: string }>;
  data?: Array<{ id: string }>;
  count?: number;
  meta?: { totalCount?: number; [key: string]: unknown };
};

type CachedInfiniteList = {
  pages?: unknown[];
  pageParams?: unknown[];
};

function removeDeletedIdsFromCache(
  old: unknown,
  deletedIds: Set<string>,
): unknown {
  if (Array.isArray(old)) {
    return old.filter(
      (item) =>
        !(
          item &&
          typeof item === "object" &&
          deletedIds.has(String((item as { id?: unknown }).id))
        ),
    );
  }

  if (!old || typeof old !== "object") {
    return old;
  }

  const maybeInfinite = old as CachedInfiniteList;
  if (Array.isArray(maybeInfinite.pages)) {
    return {
      ...maybeInfinite,
      pages: maybeInfinite.pages.map((page) =>
        removeDeletedIdsFromCache(page, deletedIds),
      ),
    };
  }

  const list = old as CachedList;
  const source = Array.isArray(list.items)
    ? "items"
    : Array.isArray(list.data)
      ? "data"
      : null;

  if (source === null) {
    return old;
  }

  const current = list[source] ?? [];
  const next = current.filter((item) => !deletedIds.has(item.id));
  const removed = current.length - next.length;
  if (removed === 0) {
    return old;
  }

  return {
    ...list,
    [source]: next,
    ...(typeof list.count === "number"
      ? { count: Math.max(0, list.count - removed) }
      : null),
    ...(list.meta && typeof list.meta.totalCount === "number"
      ? {
          meta: {
            ...list.meta,
            totalCount: Math.max(0, list.meta.totalCount - removed),
          },
        }
      : null),
  };
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
  TData extends { id: string; name?: string | null },
>({
  deletable,
  extraActions,
  emptyLabel,
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
        invalidateTRPCQueries(queryClient, deletable.invalidateKeys);
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
        await cancelTRPCQueries(queryClient, deletable.invalidateKeys);

        // Snapshot the previous value for rollback
        const previousData: Array<[QueryKey, unknown]> = [];
        for (const key of deletable.invalidateKeys) {
          previousData.push(
            ...queryClient.getQueriesData({
              queryKey: normalizeTRPCQueryKey(key),
            }),
          );
        }

        // Optimistically remove deleted items from all relevant queries
        const deletedIds = new Set(variables.ids);
        for (const key of deletable.invalidateKeys) {
          queryClient.setQueriesData(
            { queryKey: normalizeTRPCQueryKey(key) },
            (old: unknown) => removeDeletedIdsFromCache(old, deletedIds),
          );
        }

        return { previousData };
      },
      onError: (
        err: unknown,
        _variables: unknown,
        context: { previousData?: Array<[QueryKey, unknown]> } | undefined,
      ) => {
        // Roll back optimistic update on error
        if (context?.previousData) {
          for (const [key, data] of context.previousData) {
            queryClient.setQueryData(key, data);
          }
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

  // Always call useMutation unconditionally (Rules of Hooks).
  // When deletable is not configured, pass a no-op mutation function.
  const noopMutationOptions = useMemo(
    () => ({ mutationFn: async () => {} }),
    [],
  );
  const deleteMutation = useMutation(
    (deleteMutationOptions ?? noopMutationOptions) as Parameters<
      typeof useMutation
    >[0],
  );

  // Build delete bulk action
  const deleteBulkAction = useMemo((): BulkAction<TData> | null => {
    if (!deletable) return null;

    return {
      id: "delete" as const,
      label: "Delete",
      icon: <Trash className="size-4" />,
      requiresConfirmation: true,
      onExecute: async (selectedRows: { original: TData }[]) => {
        await deleteMutation.mutateAsync({
          ids: selectedRows.map((row) => row.original.id),
        });
        return { success: true };
      },
    };
  }, [deletable, deleteMutation.mutateAsync]);

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
              <Trash />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </>
    );
  }, [deletable, extraActions]);

  // Impact preview — fetched only while the dialog is open, for the current
  // target. See `useOperationPreview`'s doc comment for the gating rule: it
  // never disables confirmation, except the one case handled below.
  const previewInput = useMemo(
    () =>
      deletable && deleteTarget
        ? {
            operation: "delete" as const,
            entity: deletable.entity,
            ids: [deleteTarget.id],
          }
        : null,
    [deletable, deleteTarget],
  );
  const preview = useOperationPreview(previewInput, deleteTarget !== null);

  // Build delete dialog element
  const deleteDialog = useMemo(
    () =>
      deletable ? (
        <BulkActionDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          items={
            deleteTarget
              ? [
                  {
                    id: deleteTarget.id,
                    name:
                      deleteTarget.name ||
                      emptyLabel?.(deleteTarget) ||
                      deleteTarget.id,
                  },
                ]
              : []
          }
          itemNoun={deletable.entityLabel}
          action="Delete"
          variant="destructive"
          pendingLabel="Deleting..."
          description={`This will permanently remove ${deletable.entityLabel.toLowerCase()} from your workspace. This action cannot be undone.`}
          renderItem={(item) => item.name}
          onSubmit={async () => {
            if (deleteTarget) {
              await deleteMutation.mutateAsync({ ids: [deleteTarget.id] });
              setDeleteTarget(null);
            }
          }}
          isPending={deletable ? deleteMutation.isPending : false}
          blocked={preview.data?.canProceed === false}
        >
          <OperationImpact
            preview={preview.data}
            isLoading={preview.isLoading}
            isError={preview.isError}
            onRetry={() => void preview.refetch()}
          />
        </BulkActionDialog>
      ) : null,
    // Not `deleteMutation`/`preview` wholesale — react-query hands back a new
    // result object every render, so depending on either made this memo a
    // no-op. `mutateAsync`/`refetch` are bound once by their observers; only
    // the scalar fields are read.
    [
      deletable,
      deleteTarget,
      deleteMutation.isPending,
      deleteMutation.mutateAsync,
      emptyLabel,
      preview.data,
      preview.isLoading,
      preview.isError,
      preview.refetch,
    ],
  );

  return {
    deleteBulkAction,
    combinedExtraActions,
    deleteDialog,
    requestDelete: setDeleteTarget,
  };
}
