import type { PreviewDeleteEntity } from "@cubby/schemas/entity-integrity";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import pluralize from "pluralize";
import type { ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  OperationImpact,
  useOperationPreview,
} from "~/app/_components/impact/operation-impact";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { DropdownMenuSeparator } from "~/components/ui/dropdown-menu";
import type { EditableEntity } from "~/entities/editing";
import { useEntityCommands } from "~/entities/editing";
import {
  cancelTRPCQueries,
  invalidateTRPCQueries,
  normalizeTRPCQueryKey,
} from "~/lib/query-keys";
import { VerbMenuItem, verbBulkAction } from "../actions/action-verb-ui";
import type { BulkAction } from "../data-table/bulk-actions.types";

interface DeletableConfig {
  /** tRPC delete mutation options factory */
  mutationOptions: (callbacks: {
    onSuccess: () => void;
    onError: (err: { message?: string }) => void;
  }) => unknown;
  entityLabel: string;
  invalidateKeys: readonly QueryKey[];
  /** Entity slug for the operation-impact preview fetched while the confirm dialog is open. */
  entity: PreviewDeleteEntity;
}

interface UseOptimisticDeleteOptions<TData extends { id: string }> {
  deletable: DeletableConfig | undefined;
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

interface UseOptimisticDeleteReturn<TData extends { id: string }> {
  deleteBulkAction: BulkAction<TData> | null;
  combinedExtraActions: ((row: TData) => ReactNode) | undefined;
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
 *
 * Single-row delete (row menu / swipe action) and bulk delete (selection
 * toolbar) are the same flow over a list of targets — one preview, one
 * dialog — rather than two tiers with different confirmation UX. A bulk
 * delete of one row and a row-menu delete of that same row render identically.
 */
export function useOptimisticDelete<
  TData extends { id: string; name?: string | null },
>({
  deletable,
  extraActions,
  emptyLabel,
}: UseOptimisticDeleteOptions<TData>): UseOptimisticDeleteReturn<TData> {
  const queryClient = useQueryClient();
  const registeredDelete =
    deletable !== undefined &&
    deletable.entity !== "image" &&
    deletable.entity !== "cookbook";
  const commandEntity = (
    registeredDelete ? deletable.entity : "product"
  ) as EditableEntity;
  const commands = useEntityCommands(commandEntity);
  const [deleteTargets, setDeleteTargets] = useState<TData[] | null>(null);
  // Set only while the dialog was opened via the bulk-action toolbar. Lets the
  // dialog resolve `deleteBulkAction.onExecute`'s promise on close/submit so
  // `useBulkActions.executeAction` knows whether to clear the row selection —
  // the bulk action bar owns that state, not this hook.
  const bulkResolveRef = useRef<
    ((result: { success: boolean }) => void) | null
  >(null);

  // Memoize the mutation options to prevent infinite re-renders
  const deleteMutationOptions = useMemo(() => {
    if (!deletable) return null;

    const onSuccess = () => {
      toast.success(`${deletable.entityLabel} deleted`);
      if (!registeredDelete) {
        invalidateTRPCQueries(queryClient, deletable.invalidateKeys);
      }
    };
    const onError = (err: { message?: string }) => {
      toast.error(
        err.message ||
          `Failed to delete ${deletable.entityLabel.toLowerCase()}`,
      );
    };
    const baseMutationOptions = registeredDelete
      ? ({
          mutationFn: async ({ ids }: { ids: string[] }) =>
            await commands.executeOrThrow({
              entity: commandEntity,
              operation: "delete",
              intent: "delete",
              ids,
              data: {},
            }),
          onSuccess,
          onError,
        } as Record<string, unknown>)
      : (deletable.mutationOptions({ onSuccess, onError }) as Record<
          string,
          unknown
        >);

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
  }, [
    commandEntity,
    commands.executeOrThrow,
    deletable,
    queryClient,
    registeredDelete,
  ]);

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

  // Opens the dialog for a single row (row menu / swipe action). Not part of
  // the bulk-action toolbar, so nothing needs to resolve on close.
  const requestDelete = useCallback((item: TData) => {
    bulkResolveRef.current = null;
    setDeleteTargets([item]);
  }, []);

  // Settle the bulk action's held-open promise, if this dialog session came
  // from the toolbar. `success: true` lets `useBulkActions.executeAction`
  // clear the row selection; `success: false` (cancel) leaves it alone.
  const settleBulkAction = useCallback((result: { success: boolean }) => {
    bulkResolveRef.current?.(result);
    bulkResolveRef.current = null;
  }, []);

  // Build delete bulk action. `onExecute` doesn't delete anything itself — it
  // opens the same preview-backed dialog `requestDelete` does, over the whole
  // selection, and holds its returned promise open until the dialog resolves
  // it (submit or cancel). That's what lets `BulkActionBar` skip its own
  // generic "are you sure" dialog for this action (no `requiresConfirmation`)
  // without losing confirmation altogether.
  //
  // Consequence worth knowing before reusing this action elsewhere: because the
  // promise is held open across confirmation, `useBulkActions.executeAction`
  // flips `isExecuting` true as soon as the dialog OPENS, not when the mutation
  // starts — so here `isExecuting` means "confirming or deleting", not
  // "deleting". Harmless today because the dialog is a modal overlay that hides
  // the toolbar spinner and disabled sibling buttons it drives. A non-modal
  // surface reusing this action would surface that state to the user and would
  // need to tell the two apart.
  const deleteBulkAction = useMemo((): BulkAction<TData> | null => {
    if (!deletable) return null;

    return verbBulkAction<TData>("delete", {
      onExecute: (selectedRows) =>
        new Promise<{ success: boolean }>((resolve) => {
          bulkResolveRef.current = resolve;
          setDeleteTargets(selectedRows.map((row) => row.original));
        }),
    });
  }, [deletable]);

  // Combine user's extra actions with delete action if deletable is provided
  const combinedExtraActions = useMemo(() => {
    if (!deletable && !extraActions) return undefined;

    return (row: TData) => (
      <>
        {extraActions?.(row)}
        {deletable && (
          <>
            <DropdownMenuSeparator />
            <VerbMenuItem
              verb="delete"
              onSelect={(e) => {
                e.stopPropagation();
                requestDelete(row);
              }}
            />
          </>
        )}
      </>
    );
  }, [deletable, extraActions, requestDelete]);

  const targetCount = deleteTargets?.length ?? 0;

  // Impact preview — fetched only while the dialog is open, for the current
  // target(s). See `useOperationPreview`'s doc comment for the gating rule: it
  // never disables confirmation, except the one case handled below.
  const previewInput = useMemo(
    () =>
      deletable && deleteTargets && deleteTargets.length > 0
        ? {
            operation: "delete" as const,
            entity: deletable.entity,
            ids: deleteTargets.map((target) => target.id),
          }
        : null,
    [deletable, deleteTargets],
  );
  const preview = useOperationPreview(previewInput, targetCount > 0);

  // Build delete dialog element
  const deleteDialog = useMemo(
    () =>
      deletable ? (
        <BulkActionDialog
          open={deleteTargets !== null}
          onOpenChange={(open) => {
            if (open) return;
            setDeleteTargets(null);
            settleBulkAction({ success: false });
          }}
          items={
            deleteTargets?.map((target) => ({
              id: target.id,
              name: target.name || emptyLabel?.(target) || target.id,
            })) ?? []
          }
          itemNoun={deletable.entityLabel}
          action="Delete"
          variant="destructive"
          pendingLabel="Deleting..."
          description={`This will permanently remove ${pluralize(
            deletable.entityLabel.toLowerCase(),
            targetCount || 1,
          )} from your workspace. This action cannot be undone.`}
          renderItem={(item) => item.name}
          onSubmit={async () => {
            if (!deleteTargets || deleteTargets.length === 0) return;
            await deleteMutation.mutateAsync({
              ids: deleteTargets.map((target) => target.id),
            });
            setDeleteTargets(null);
            settleBulkAction({ success: true });
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
      deleteTargets,
      targetCount,
      settleBulkAction,
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
    requestDelete,
  };
}
