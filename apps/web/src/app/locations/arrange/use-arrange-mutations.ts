import {
  type LocationShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { inventory } from "~/app/inventory/inventory.functions";
import { location } from "~/app/locations/location.functions";
import { showErrorToast } from "~/components/feedback/error-details";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";

import { applyItemMove, applyLocationMove } from "./arrange-tree-utils";
import type { ItemDragData } from "./arrange-types";

/**
 * The two drop mutations for the arrange surface: reparent a location and move
 * an inventory item's whole entry. Both do optimistic surgery on the shared
 * `makeTree` cache (instant feedback), then reconcile a failed move by
 * invalidating rather than restoring an obsolete whole-tree snapshot. Both views call the returned
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
    onMutate: async (vars) => {
      const dragId = vars.ids[0];
      await queryClient.cancelQueries({ queryKey: treeKey });
      const current = queryClient.getQueryData<InfLocation[]>(treeKey);
      if (current && dragId) {
        queryClient.setQueryData(
          treeKey,
          applyLocationMove(
            current,
            parseShortcodeFor("location", dragId),
            vars.parentId == null
              ? null
              : parseShortcodeFor("location", vars.parentId),
          ),
        );
      }
    },
    onError: (err) => {
      void invalidateOperationTags(queryClient, ripple.location);
      showErrorToast(err);
    },
  });

  const moveBase = inventory.bulkMove.mutationOptions();
  const move = useMutation({
    ...moveBase,
    onMutate: async (vars) => {
      const first = vars.items[0];
      await queryClient.cancelQueries({ queryKey: treeKey });
      const current = queryClient.getQueryData<InfLocation[]>(treeKey);
      if (current && first) {
        queryClient.setQueryData(
          treeKey,
          applyItemMove(
            current,
            parseShortcodeFor("inventory", first.inventoryEntryId),
            parseShortcodeFor("location", vars.sourceLocationId),
            parseShortcodeFor("location", vars.targetLocationId),
          ),
        );
      }
    },
    onError: (err) => {
      void invalidateOperationTags(queryClient, ripple.location);
      showErrorToast(err);
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
