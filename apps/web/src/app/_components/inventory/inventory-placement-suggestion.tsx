import type { InventoryPlacementProposal } from "@cubby/schemas/entity-recommendations";
import type { InventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { useInventoryInvalidation } from "~/app/_components/inventory/hooks";
import {
  EntityRecommendations,
  type EntityRecommendationOperations,
} from "~/app/_components/relatedness/entity-recommendations";
import { inventory } from "~/app/inventory/inventory.functions";
import { entityDetailLink } from "~/entities/entities";
import { entityDetailFor } from "~/entities/entity-detail.functions";

interface InventoryPlacementSuggestionProps {
  inventoryitem: InventoryWithLocationAndProductOut;
  recommendationOperations?: EntityRecommendationOperations;
  moveOperation?: typeof inventory.moveEntries;
}

export function useInventoryPlacementAction({
  inventoryitem,
  moveOperation = inventory.moveEntries,
}: {
  inventoryitem?: InventoryWithLocationAndProductOut;
  moveOperation?: typeof inventory.moveEntries;
} = {}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const invalidateInventory = useInventoryInvalidation();
  const move = useMutation(
    moveOperation.mutationOptions({
      onSuccess: (result) => invalidateInventory(result),
    }),
  );

  return {
    isPending: move.isPending,
    accept: async (proposal: InventoryPlacementProposal) => {
      const source =
        inventoryitem ??
        (await queryClient.fetchQuery(
          entityDetailFor("inventory").queryOptions(proposal.inventoryId),
        ));
      if (!source) throw new Error("Inventory item is no longer available.");
      const result = await move.mutateAsync({
        items: [
          {
            inventoryEntryId: source.id,
            targetLocationId: proposal.target.id,
            quantity: source.amount,
          },
        ],
      });
      const surviving = result.items[0];
      if (surviving && surviving.id !== source.id) {
        await navigate({
          ...entityDetailLink("inventory", surviving.id),
          replace: true,
        });
      }
    },
  };
}

/** Inline proposal for stock currently parked in a staging location. */
export function InventoryPlacementSuggestion({
  inventoryitem,
  recommendationOperations,
  moveOperation = inventory.moveEntries,
}: InventoryPlacementSuggestionProps) {
  const placement = useInventoryPlacementAction({
    inventoryitem,
    moveOperation,
  });

  return (
    <div className="mt-3">
      <EntityRecommendations
        source={{ entityType: "inventory", entityId: inventoryitem.id }}
        operations={recommendationOperations}
        compact
        pending={placement.isPending}
        onAcceptInventoryPlacement={placement.accept}
      />
    </div>
  );
}
