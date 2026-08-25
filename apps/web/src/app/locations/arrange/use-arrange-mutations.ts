import {
  type LocationShortcode,
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
} from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import {
  cancelQueryRoots,
  invalidateQueryRoots,
  invalidatesFor,
} from "~/lib/query-keys";
import { applyItemMove, applyLocationMove } from "./arrange-tree-utils";
import type { ItemDragData } from "./arrange-types";

type OptimisticContext = { prev: InfLocation[] | undefined };

/**
 * The two drop mutations for the arrange surface: reparent a location and move
 * an inventory item's whole entry. Both do optimistic surgery on the shared
 * `makeTree` cache (instant feedback), roll back on error, and reconcile
 * rollups via an `onSettled` invalidation. Both views call the returned
 * `moveLocation` / `moveItem` — the cache they mutate is the same, so a move in
 * one view is reflected after toggling to the other.
 *
 * We pull `mutationFn`/`mutationKey` off the tRPC options rather than spreading
 * the whole object so react-query infers the optimistic context type cleanly.
 * tRPC input types are plain strings (branded schemas widen on input), so we
 * re-brand at this string→domain boundary with the `unsafe*Id` converters.
 */
export function useArrangeMutations() {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const treeKey = api.location.makeTree.queryKey();

  const reparentBase = api.location.bulkUpdateParent.mutationOptions();
  const reparent = useMutation({
    mutationKey: reparentBase.mutationKey,
    mutationFn: reparentBase.mutationFn,
    onMutate: async (vars): Promise<OptimisticContext> => {
      const dragId = vars.ids[0];
      await cancelQueryRoots(queryClient, [treeKey]);
      const prev = queryClient.getQueryData<InfLocation[]>(treeKey);
      if (prev && dragId) {
        queryClient.setQueryData(
          treeKey,
          applyLocationMove(
            prev,
            unsafeLocationShortcode(dragId),
            vars.parentId == null
              ? null
              : unsafeLocationShortcode(vars.parentId),
          ),
        );
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(treeKey, ctx.prev);
      toast.error(getErrorMessage(err));
    },
    onSettled: () =>
      invalidateQueryRoots(queryClient, invalidatesFor("inventory")),
  });

  const moveBase = api.inventory.bulkMove.mutationOptions();
  const move = useMutation({
    mutationKey: moveBase.mutationKey,
    mutationFn: moveBase.mutationFn,
    onMutate: async (vars): Promise<OptimisticContext> => {
      const first = vars.items[0];
      await cancelQueryRoots(queryClient, [treeKey]);
      const prev = queryClient.getQueryData<InfLocation[]>(treeKey);
      if (prev && first) {
        queryClient.setQueryData(
          treeKey,
          applyItemMove(
            prev,
            unsafeInventoryShortcode(first.inventoryEntryId),
            unsafeLocationShortcode(vars.sourceLocationId),
            unsafeLocationShortcode(vars.targetLocationId),
          ),
        );
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(treeKey, ctx.prev);
      toast.error(getErrorMessage(err));
    },
    onSettled: () =>
      invalidateQueryRoots(queryClient, invalidatesFor("inventory")),
  });

  return {
    moveLocation: (
      dragId: LocationShortcode,
      targetId: LocationShortcode | null,
    ) => reparent.mutate({ ids: [dragId], parentId: targetId }),
    moveItem: (drag: ItemDragData, targetLocationId: LocationShortcode) =>
      move.mutate({
        sourceLocationId: drag.sourceLocationId,
        targetLocationId,
        items: [
          { inventoryEntryId: drag.inventoryEntryId, quantity: drag.amount },
        ],
      }),
  };
}
