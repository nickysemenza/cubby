import type { InventoryShortcode } from "@cubby/schemas/identifiers";
import type {
  placementRecommendationInput,
  placementRecommendationOut,
} from "@cubby/schemas/recommendations";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  getInventoryEntryByShortcode,
  getProductStockRows,
} from "~/server/repo/inventory";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

type PlacementRecommendation = z.infer<typeof placementRecommendationOut>;

export interface PlacementRecommendationPorts {
  readonly getInventoryEntryByShortcode: typeof getInventoryEntryByShortcode;
  readonly getProductStockRows: typeof getProductStockRows;
  readonly resolveOrThrow: typeof resolveOrThrow;
}

export const productionPlacementRecommendationPorts: PlacementRecommendationPorts =
  {
    getInventoryEntryByShortcode,
    getProductStockRows,
    resolveOrThrow,
  };

/**
 * A parked row earns a destination only when its exact Product already has one
 * other live stock location. Ambiguous filing stays in Problems as a prompt;
 * this never labels an unproven location as a stray or moves automatically.
 */
type PlacementRecommendationContext = {
  readonly db: Database;
  readonly ports: PlacementRecommendationPorts;
};
type PlacementInput = z.output<typeof placementRecommendationInput>;
/** Inspectable read-only graph for the placement suggestion. */
export const placementRecommendationWorkflowDefinition = workflow<
  PlacementRecommendationContext,
  PlacementInput
>("recommendations.placement")
  .call("source", async ({ context }, { input }) =>
    context.ports.getInventoryEntryByShortcode(context.db, input.inventoryId),
  )
  .branch("eligible", {
    when: async (_, { source }) =>
      source !== null &&
      source.placement === "stock" &&
      source.location.name === "Unknown",
    whenTrue: (branch) =>
      branch
        .call("productId", async ({ context }, { input }) => {
          const { source } = input;
          if (!source) throw new Error("Placement source disappeared");
          return context.ports.resolveOrThrow(
            context.db,
            "product",
            source.product.id,
          );
        })
        .call("stockRows", async ({ context }, { productId }) =>
          context.ports.getProductStockRows(context.db, productId),
        )
        .call(
          "recommendation",
          async (_, { input, stockRows }): Promise<PlacementRecommendation> => {
            const { source } = input;
            if (!source) return null;
            const destinations = stockRows.filter(
              (row) => row.id !== source.id && row.location.name !== "Unknown",
            );
            if (destinations.length !== 1) return null;
            const destination = destinations[0]!;
            return {
              inventoryId: source.id,
              productName: source.product.name,
              sourceLocation: {
                id: source.location.id,
                name: source.location.name,
              },
              destination: {
                id: destination.location.id,
                name: destination.location.name,
              },
            };
          },
        )
        .output(({ recommendation }) => recommendation),
    whenFalse: (branch) => branch.output((): PlacementRecommendation => null),
  })
  .output(({ eligible }) => eligible);

export const getPlacementRecommendation = bindWorkflow(
  placementRecommendationWorkflowDefinition,
  (
    db: Database,
    inventoryId: InventoryShortcode,
    ports: PlacementRecommendationPorts = productionPlacementRecommendationPorts,
  ) => ({
    context: { db, ports },
    input: { inventoryId },
  }),
);
