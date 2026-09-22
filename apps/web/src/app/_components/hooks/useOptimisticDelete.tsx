import type { QueryKey, UseMutationOptions } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { DropdownMenuSeparator } from "~/components/ui/dropdown-menu";
import type {
  EditableEntity,
  EntityEditResult,
} from "~/entities/editing/types";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import {
  cancelQueriesByTags,
  restoreQueries,
  snapshotQueriesByTags,
  updateQueriesByTags,
} from "~/integrations/tanstack-query/operation-cache";
import type { OperationCacheTag } from "~/integrations/tanstack-query/operation-meta";
import { removeCachedListItems } from "~/lib/optimistic-list";
import { pluralWord } from "~/lib/pluralize";

import { VerbMenuItem, verbBulkAction } from "../actions/action-verb-ui";
import { defineEntityAction } from "../actions/entity-action-definition";
import type {
  EntityActionDefinition,
  EntityActionRow,
} from "../actions/entity-actions";
import type { BulkAction } from "../data-table/bulk-actions.types";
import type {
  DeletableConfig,
  DeleteMutationResult,
  DeleteMutationVariables,
} from "./useDeletableConfig";

interface DeleteCommandPort {
  remove: (ids: readonly string[]) => Promise<EntityEditResult<EditableEntity>>;
}

interface DeleteRollbackContext {
  previousData: Array<[QueryKey, unknown]>;
}

interface DeleteTarget extends EntityActionRow {
  displayName: string;
}

type OptimisticDeleteMutationOptions = UseMutationOptions<
  DeleteMutationResult,
  Error,
  DeleteMutationVariables,
  DeleteRollbackContext
>;

interface UseOptimisticDeleteOptions<TData extends { id: string }> {
  deletable: DeletableConfig | undefined;
  extraActions?: (row: TData) => ReactNode;
  /** Testable command boundary; production uses the registered entity command. */
  commandPort?: DeleteCommandPort;
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
  /** Catalog adapter used by canonical entity lists. */
  deleteActionDefinition: EntityActionDefinition | null;
  combinedExtraActions: ((row: TData) => ReactNode) | undefined;
  deleteDialog: ReactNode | null;
  /** Opens the delete confirmation dialog for one item (e.g. swipe actions) */
  requestDelete: (item: TData) => void;
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
 * toolbar) are the same flow over a list of targets — one dialog — rather
 * than two tiers with different confirmation UX. A bulk delete of one row and
 * a row-menu delete of that same row render identically.
 */
export function useOptimisticDelete<
  TData extends { id: string; name?: string | null },
>({
  deletable,
  extraActions,
  commandPort,
  emptyLabel,
}: UseOptimisticDeleteOptions<TData>): UseOptimisticDeleteReturn<TData> {
  const queryClient = useQueryClient();
  const registeredDelete =
    deletable?.entity !== undefined && deletable.entity !== "image";
  const commandEntity: EditableEntity =
    deletable?.entity && deletable.entity !== "image"
      ? deletable.entity
      : "product";
  const commands = useEntityCommands(commandEntity);
  const deleteCommands: DeleteCommandPort = commandPort ?? commands;
  const [deleteTargets, setDeleteTargets] = useState<DeleteTarget[] | null>(
    null,
  );
  // Set only while the dialog was opened via the bulk-action toolbar. Lets the
  // dialog resolve `deleteBulkAction.onExecute`'s promise on close/submit so
  // `useBulkActions.executeAction` knows whether to clear the row selection —
  // the bulk action bar owns that state, not this hook.
  const bulkResolveRef = useRef<
    ((result: { success: boolean }) => void) | null
  >(null);

  // Memoize the mutation options to prevent infinite re-renders
  const deleteMutationOptions =
    useMemo<OptimisticDeleteMutationOptions | null>(() => {
      if (!deletable) return null;

      // No invalidation here. The root MutationCache owns it, from the
      // descriptor's own fan-out — which is WIDER than the surface patched below,
      // and correctly so. Coupling the two is what forced the patch to walk a
      // whole entity fan-out and rewrite unrelated caches on the way past.
      const onSuccess = () => {
        toast.success(`${deletable.entityLabel} deleted`);
      };
      const onError = (error: Error) => {
        toast.error(
          error.message ||
            `Failed to delete ${deletable.entityLabel.toLowerCase()}`,
        );
      };
      const baseMutationOptions = registeredDelete
        ? ({
            mutationFn: async ({ ids }) => {
              const result = await deleteCommands.remove(ids);
              if (!result.ok) {
                throw new Error(result.issues[0]?.message ?? "Delete failed");
              }
              return { deleted: ids.length };
            },
          } satisfies OptimisticDeleteMutationOptions)
        : deletable.mutationOptions();

      // Extend with optimistic updates
      return {
        ...baseMutationOptions,
        onMutate: async (variables: { ids: string[] }) => {
          // The NARROW surface: only queries that list this entity's own rows can
          // have a deleted id spliced out of them. A product delete ripples to
          // recipes and dashboards too, but `removeDeletedIdsFromCache` has
          // nothing sensible to say about those — it would walk them, match no
          // id, and hand back the same object.
          const patched: readonly OperationCacheTag[] = [[deletable.entity]];
          await cancelQueriesByTags(queryClient, patched);
          const previousData = snapshotQueriesByTags(queryClient, patched);
          const deletedIds = new Set(variables.ids);
          updateQueriesByTags(queryClient, patched, (old) =>
            removeCachedListItems(old, deletedIds),
          );
          return { previousData };
        },
        onSuccess,
        onError: (error, _variables, context) => {
          // Roll back optimistic update on error
          if (context) restoreQueries(queryClient, context.previousData);
          onError(error);
        },
      };
    }, [deleteCommands, deletable, queryClient, registeredDelete]);

  // Always call useMutation unconditionally (Rules of Hooks).
  // When deletable is not configured, pass a no-op mutation function.
  const noopMutationOptions = useMemo<OptimisticDeleteMutationOptions>(
    () => ({ mutationFn: async () => ({ deleted: 0 }) }),
    [],
  );
  const deleteMutation = useMutation<
    DeleteMutationResult,
    Error,
    DeleteMutationVariables,
    DeleteRollbackContext
  >(deleteMutationOptions ?? noopMutationOptions);
  const { isPending: isDeletePending, mutateAsync: mutateDelete } =
    deleteMutation;

  // Opens the dialog for a single row (row menu / swipe action). Not part of
  // the bulk-action toolbar, so nothing needs to resolve on close.
  const requestDelete = useCallback(
    (item: TData) => {
      bulkResolveRef.current = null;
      setDeleteTargets([
        {
          ...item,
          displayName: item.name || emptyLabel?.(item) || item.id,
        },
      ]);
    },
    [emptyLabel],
  );

  const requestActionRowDelete = useCallback((item: EntityActionRow) => {
    bulkResolveRef.current = null;
    setDeleteTargets([
      { ...item, displayName: item.name || item.filename || item.id },
    ]);
  }, []);

  // Settle the bulk action's held-open promise, if this dialog session came
  // from the toolbar. `success: true` lets `useBulkActions.executeAction`
  // clear the row selection; `success: false` (cancel) leaves it alone.
  const settleBulkAction = useCallback((result: { success: boolean }) => {
    bulkResolveRef.current?.(result);
    bulkResolveRef.current = null;
  }, []);

  // Build delete bulk action. `onExecute` performs no deletion itself — it
  // opens the same confirm dialog `requestDelete` does, over the whole
  // selection, and holds its returned promise open until the dialog resolves
  // the promise through submit or cancel. That's what lets `BulkActionBar` skip its own
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
          setDeleteTargets(
            selectedRows.map((row) => ({
              ...row.original,
              displayName:
                row.original.name ||
                emptyLabel?.(row.original) ||
                row.original.id,
            })),
          );
        }),
    });
  }, [deletable, emptyLabel]);

  const requestBulkDelete = useCallback(
    (rows: readonly EntityActionRow[]) =>
      new Promise<{ success: boolean }>((resolve) => {
        bulkResolveRef.current = resolve;
        setDeleteTargets(
          rows.map((row) => ({
            ...row,
            displayName: row.name || row.filename || row.id,
          })),
        );
      }),
    [],
  );

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

  const submitDelete = useCallback(async () => {
    if (!deleteTargets || deleteTargets.length === 0) return;
    await mutateDelete({
      ids: deleteTargets.map((target) => target.id),
    });
    setDeleteTargets(null);
    settleBulkAction({ success: true });
  }, [deleteTargets, mutateDelete, settleBulkAction]);

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
              name: target.displayName,
            })) ?? []
          }
          itemNoun={deletable.entityLabel}
          action="Delete"
          variant="destructive"
          pendingLabel="Deleting..."
          description={`This will permanently remove ${pluralWord(
            deletable.entityLabel.toLowerCase(),
            targetCount || 1,
          )} from your workspace. This action cannot be undone.`}
          renderItem={(item) => item.name}
          onSubmit={async () => {
            try {
              await submitDelete();
            }
            // SILENT: `useMutation` has already rolled back the snapshot and
            // shown the structured refusal toast; keep this dialog open for
            // retry.
            catch {}
          }}
          isPending={deletable ? isDeletePending : false}
        />
      ) : null,
    [
      deletable,
      deleteTargets,
      targetCount,
      settleBulkAction,
      isDeletePending,
      submitDelete,
    ],
  );

  const deleteActionDefinition = useMemo<EntityActionDefinition | null>(
    () =>
      deletable
        ? defineEntityAction({
            id: "delete",
            verb: "delete",
            entities: [deletable.entity],
            arity: "both",
            surfaces: ["row", "selection"],
            group: "destructive",
            priority: 1000,
            use: () => ({
              run: requestBulkDelete,
              rowMenuItem: (row) => (
                <>
                  <DropdownMenuSeparator />
                  <VerbMenuItem
                    verb="delete"
                    onSelect={(event) => {
                      event.stopPropagation();
                      requestActionRowDelete(row);
                    }}
                  />
                </>
              ),
              // The list workbench hosts this once so non-table roster modes
              // (Product shelf, Inventory shelf) share the same dialog state.
              dialog: null,
            }),
          })
        : null,
    [deletable, requestActionRowDelete, requestBulkDelete],
  );

  return {
    deleteBulkAction,
    deleteActionDefinition,
    combinedExtraActions,
    deleteDialog,
    requestDelete,
  };
}
