import {
  type LocationShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { inventory } from "~/app/inventory/inventory.functions";
import { location } from "~/app/locations/location.functions";
import { getErrorMessage } from "~/lib/error-utils";

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
 * operation input types are plain strings (branded schemas widen on input), so we
 * re-brand at this string→domain boundary with the `unsafe*Id` converters.
 */
export function useArrangeMutations() {
  const queryClient = useQueryClient();
  const treeKey = location.makeTree.queryOptions().queryKey;

  const reparentBase = location.bulkUpdateParent.mutationOptions();
  const reparent = useMutation({
    ...reparentBase,
    onMutate: async (vars): Promise<OptimisticContext> => {
      const dragId = vars.ids[0];
      await queryClient.cancelQueries({ queryKey: treeKey });
      const prev = queryClient.getQueryData<InfLocation[]>(treeKey);
      if (prev && dragId) {
        queryClient.setQueryData(
          treeKey,
          applyLocationMove(
            prev,
            parseShortcodeFor("location", dragId),
            vars.parentId == null
              ? null
              : parseShortcodeFor("location", vars.parentId),
          ),
        );
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(treeKey, ctx.prev);
      toast.error(getErrorMessage(err));
    },
  });

  const moveBase = inventory.bulkMove.mutationOptions();
  const move = useMutation({
    ...moveBase,
    onMutate: async (vars): Promise<OptimisticContext> => {
      const first = vars.items[0];
      await queryClient.cancelQueries({ queryKey: treeKey });
      const prev = queryClient.getQueryData<InfLocation[]>(treeKey);
      if (prev && first) {
        queryClient.setQueryData(
          treeKey,
          applyItemMove(
            prev,
            parseShortcodeFor("inventory", first.inventoryEntryId),
            parseShortcodeFor("location", vars.sourceLocationId),
            parseShortcodeFor("location", vars.targetLocationId),
          ),
        );
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(treeKey, ctx.prev);
      toast.error(getErrorMessage(err));
    },
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
